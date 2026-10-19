import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { Container } from '../model/container';
import Dockercompose from '../triggers/providers/dockercompose/Dockercompose';
import { planStack, composeCommand, updateStack } from './compose';
import * as yaml from 'yaml';
import { HookManager } from '../triggers/hooks/HookManager';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('../triggers/hooks/HookManager', () => ({
    HookManager: {
        runPreHooks: jest.fn(),
        runPostHooks: jest.fn(),
        runFailureHooks: jest.fn(),
    },
}));
jest.mock('../event', () => ({
    emitContainerUpdatePre: jest.fn(),
    emitContainerUpdateSuccess: jest.fn(),
    emitContainerUpdateFailure: jest.fn(),
}));

describe('native Compose project reconciliation', () => {
    let directory: string;
    let file: string;
    let container: Container;
    let trigger: Dockercompose;
    let commandFailure: string | undefined;
    const listContainers = jest.fn();
    beforeEach(async () => {
        jest.clearAllMocks();
        commandFailure = undefined;
        directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'wud-compose-unit-'),
        );
        file = path.join(directory, 'compose.yml');
        await fs.writeFile(
            file,
            'services:\n  web:\n    image: example/web:1\n',
        );
        container = {
            id: 'live-container',
            name: 'web',
            watcher: 'local',
            updateAvailable: true,
            labels: {
                'com.docker.compose.project': 'project',
                'com.docker.compose.service': 'web',
                'com.docker.compose.project.config_files': file,
                'com.docker.compose.project.working_dir': directory,
            },
        } as unknown as Container;
        listContainers.mockResolvedValue([
            { Id: container.id, Labels: container.labels },
        ]);
        trigger = Object.create(Dockercompose.prototype) as Dockercompose;
        trigger.configuration = {
            pathmapping: { host: directory, container: directory },
            hooks: [],
        };
        trigger.name = 'test';
        trigger.log = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        } as unknown as Dockercompose['log'];
        trigger.getWatcher = jest.fn().mockReturnValue({
            dockerApi: {
                modem: { socketPath: '/var/run/docker.sock' },
                listContainers,
            },
        });
        trigger.resolveRollback = jest.fn().mockReturnValue({ enabled: false });
        trigger.resolveSelfContainerId = jest.fn().mockResolvedValue(undefined);
        trigger.mapCurrentVersionToUpdateVersion = jest.fn().mockReturnValue({
            service: 'web',
            current: 'example/web:1',
            update: 'example/web:2',
        });
        (execFile as unknown as jest.Mock).mockImplementation(
            (_binary, args: string[], _options, callback) => {
                const command = args.includes('pull')
                    ? 'pull'
                    : args.includes('up')
                      ? 'up'
                      : 'config';
                if (command === commandFailure)
                    return callback(
                        Object.assign(
                            new Error('private sensitive command failure'),
                            { code: 1 },
                        ),
                        '',
                    );
                callback(
                    null,
                    args.includes('--format')
                        ? JSON.stringify({
                              services: { web: { image: 'example/web:1' } },
                          })
                        : '',
                );
            },
        );
    });
    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });
    test('requires an explicit authorized file root, local socket and valid project', async () => {
        delete trigger.configuration.pathmapping;
        await expect(planStack(trigger, container)).rejects.toThrow(
            'authorize',
        );
        trigger.configuration.file = file;
        expect((await planStack(trigger, container)).files).toEqual([file]);
        container.labels!['com.docker.compose.project'] = '--injected';
        await expect(planStack(trigger, container)).rejects.toThrow(
            'valid Compose',
        );
        container.labels!['com.docker.compose.project'] = 'project';
        (trigger.getWatcher as jest.Mock).mockReturnValue({
            dockerApi: { modem: {} },
        });
        await expect(planStack(trigger, container)).rejects.toThrow(
            'local Docker',
        );
    });
    test('rejects templates, boundary prefix escapes, symlink escapes and relative files', async () => {
        trigger.configuration.file = '${name}.yml';
        await expect(planStack(trigger, container)).rejects.toThrow(
            'templates',
        );
        delete trigger.configuration.file;
        container.labels!['com.docker.compose.project.config_files'] =
            `${directory}-evil/compose.yml`;
        await expect(planStack(trigger, container)).rejects.toThrow('outside');
        container.labels!['com.docker.compose.project.config_files'] =
            'relative.yml';
        await expect(planStack(trigger, container)).rejects.toThrow('absolute');
        const external = await fs.mkdtemp(
            path.join(os.tmpdir(), 'wud-outside-'),
        );
        try {
            await fs.writeFile(path.join(external, 'file.yml'), 'services: {}');
            const linked = path.join(directory, 'linked.yml');
            await fs.symlink(path.join(external, 'file.yml'), linked);
            container.labels!['com.docker.compose.project.config_files'] =
                linked;
            await expect(planStack(trigger, container)).rejects.toThrow(
                'outside',
            );
        } finally {
            await fs.rm(external, { recursive: true, force: true });
        }
    });
    test('preserves the ordered override files and Compose working directory', async () => {
        const sub = path.join(directory, 'sub');
        await fs.mkdir(sub);
        const first = path.join(sub, 'base.yml');
        await fs.writeFile(first, 'services: {}');
        container.labels!['com.docker.compose.project.config_files'] =
            `${first},${file}`;
        const plan = await planStack(trigger, container);
        expect(plan.files).toEqual([first, file]);
        expect(plan.directory).toBe(directory);
    });
    test('rejects a configured file that differs from the discovered primary', async () => {
        const other = path.join(directory, 'other.yml');
        await fs.writeFile(other, 'services: {}');
        trigger.configuration.file = other;
        await expect(planStack(trigger, container)).rejects.toThrow(
            'primary file',
        );
    });
    test('keeps every ordered override when the configured primary matches', async () => {
        const override = path.join(directory, 'override.yml');
        const final = path.join(directory, 'final.yml');
        await fs.writeFile(override, 'services: {}');
        await fs.writeFile(final, 'services: {}');
        trigger.configuration.file = file;
        container.labels!['com.docker.compose.project.config_files'] =
            `${file},${override},${final}`;
        expect((await planStack(trigger, container)).files).toEqual([
            file,
            override,
            final,
        ]);
    });
    test('rewrites only the highest precedence image declaration', async () => {
        const override = path.join(directory, 'override.yml');
        const trailing = path.join(directory, 'resources.yml');
        const original = await fs.readFile(file, 'utf8');
        const resources = 'services:\n  web:\n    restart: always\n';
        await fs.writeFile(override, original);
        await fs.writeFile(trailing, resources);
        container.labels!['com.docker.compose.project.config_files'] =
            `${file},${override},${trailing}`;
        await updateStack(trigger, [container]);
        expect(await fs.readFile(file, 'utf8')).toBe(original);
        expect(await fs.readFile(trailing, 'utf8')).toBe(resources);
        expect(
            yaml.parse(await fs.readFile(override, 'utf8')).services.web.image,
        ).toBe('example/web:2');
    });
    test('pulls floating digest updates without rewriting interpolated image sources', async () => {
        const original = 'services:\n  web:\n    image: ${WEB_IMAGE}\n';
        await fs.writeFile(file, original);
        (trigger.mapCurrentVersionToUpdateVersion as jest.Mock).mockReturnValue(
            {
                service: 'web',
                current: 'example/web:1',
                update: 'example/web:1',
            },
        );
        await updateStack(trigger, [container]);
        expect(await fs.readFile(file, 'utf8')).toBe(original);
        const calls = (execFile as unknown as jest.Mock).mock.calls.map(
            (call) => call[1] as string[],
        );
        expect(calls.some((args) => args.includes('pull'))).toBe(true);
        expect(calls.some((args) => args.includes('up'))).toBe(true);
    });
    test('rejects Compose profiles before hooks and mutation', async () => {
        const original = await fs.readFile(file, 'utf8');
        (execFile as unknown as jest.Mock).mockImplementation(
            (_binary, args: string[], _options, callback) =>
                callback(
                    null,
                    args.includes('--format')
                        ? JSON.stringify({
                              services: {
                                  web: {
                                      image: 'example/web:1',
                                      profiles: ['debug'],
                                  },
                              },
                          })
                        : '',
                ),
        );
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'profiles',
        );
        expect(await fs.readFile(file, 'utf8')).toBe(original);
        expect(HookManager.runPreHooks).not.toHaveBeenCalled();
    });
    test('restores original content when a write truncates the file then rejects', async () => {
        const original = await fs.readFile(file, 'utf8');
        const realWriteFile = fs.writeFile.bind(fs);
        const write = jest
            .spyOn(fs, 'writeFile')
            .mockImplementationOnce(async (destination) => {
                await realWriteFile(destination, '');
                throw new Error('disk write failed');
            });
        try {
            await expect(updateStack(trigger, [container])).rejects.toThrow(
                'disk write failed',
            );
            expect(await fs.readFile(file, 'utf8')).toBe(original);
            expect(write).toHaveBeenCalledTimes(2);
            expect(HookManager.runFailureHooks).toHaveBeenCalled();
            const calls = (execFile as unknown as jest.Mock).mock.calls.map(
                (call) => call[1] as string[],
            );
            expect(
                calls.some(
                    (args) => args.includes('pull') || args.includes('up'),
                ),
            ).toBe(false);
        } finally {
            write.mockRestore();
        }
    });
    test('executes shell-free bounded commands with explicit daemon and sanitized routing', async () => {
        const oldHost = process.env.DOCKER_HOST;
        const oldConfig = process.env.DOCKER_CONFIG;
        const oldCompose = process.env.COMPOSE_FILE;
        process.env.DOCKER_HOST = 'tcp://wrong';
        process.env.DOCKER_CONFIG = '/test/auth';
        process.env.COMPOSE_FILE = 'wrong.yml';
        try {
            await composeCommand(await planStack(trigger, container), ['pull']);
            const [binary, args, options] = (execFile as unknown as jest.Mock)
                .mock.calls[0];
            expect(binary).toBe('docker');
            expect(args).toContain('unix:///var/run/docker.sock');
            expect(options.timeout).toBe(300000);
            expect(options.env.DOCKER_HOST).toBeUndefined();
            expect(options.env.COMPOSE_FILE).toBeUndefined();
            expect(options.env.DOCKER_CONFIG).toBe('/test/auth');
        } finally {
            for (const [key, value] of Object.entries({
                DOCKER_HOST: oldHost,
                DOCKER_CONFIG: oldConfig,
                COMPOSE_FILE: oldCompose,
            })) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
    test('rewrites pins then pulls and reconciles the entire project without service arguments', async () => {
        await updateStack(trigger, [container]);
        expect(
            (
                yaml.parse(await fs.readFile(file, 'utf8')) as {
                    services: { web: { image: string } };
                }
            ).services.web.image,
        ).toBe('example/web:2');
        const calls = (execFile as unknown as jest.Mock).mock.calls.map(
            (call) => call[1] as string[],
        );
        expect(
            calls.some(
                (args) =>
                    args.includes('pull') &&
                    args.includes('--ignore-buildable'),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (args) =>
                    args.includes('up') &&
                    args.includes('--no-build') &&
                    args.includes('--detach'),
            ),
        ).toBe(true);
        expect(
            calls.every(
                (args) =>
                    !args.includes('--remove-orphans') &&
                    !args.includes('down'),
            ),
        ).toBe(true);
        expect(HookManager.runPreHooks).toHaveBeenCalled();
        expect(HookManager.runPostHooks).toHaveBeenCalled();
    });
    test.each(['pull', 'up'])(
        'restores original declarations on %s failure and reports failure',
        async (command) => {
            commandFailure = command;
            await expect(updateStack(trigger, [container])).rejects.toThrow(
                `Compose ${command} failed`,
            );
            expect(await fs.readFile(file, 'utf8')).toContain('example/web:1');
            expect(HookManager.runFailureHooks).toHaveBeenCalled();
        },
    );
    test('refuses configured rollback, WUD own project and unobserved project services', async () => {
        (trigger.resolveRollback as jest.Mock).mockReturnValue({
            enabled: true,
        });
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'rollback',
        );
        (trigger.resolveRollback as jest.Mock).mockReturnValue({
            enabled: false,
        });
        (trigger.resolveSelfContainerId as jest.Mock).mockResolvedValue(
            container.id,
        );
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'self-update',
        );
        (trigger.resolveSelfContainerId as jest.Mock).mockResolvedValue(
            undefined,
        );
        listContainers.mockResolvedValue([{ Id: 'not-monitored', Labels: {} }]);
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'every existing',
        );
        expect(execFile).not.toHaveBeenCalled();
    });
    test('preserves deployed image declarations when a post hook rejects after successful up', async () => {
        (HookManager.runPostHooks as jest.Mock).mockRejectedValueOnce(
            new Error('post hook failed'),
        );
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'post hook failed',
        );
        expect(
            yaml.parse(await fs.readFile(file, 'utf8')).services.web.image,
        ).toBe('example/web:2');
        const calls = (execFile as unknown as jest.Mock).mock.calls.map(
            (call) => call[1] as string[],
        );
        expect(calls.some((args) => args.includes('up'))).toBe(true);
        expect(HookManager.runFailureHooks).toHaveBeenCalledTimes(1);
    });
    test('reports manual recovery and runs failure hooks when restoring declarations fails', async () => {
        const realWriteFile = fs.writeFile.bind(fs);
        const write = jest
            .spyOn(fs, 'writeFile')
            .mockImplementationOnce((...args) => realWriteFile(...args))
            .mockRejectedValueOnce(new Error('restoration disk failure'));
        commandFailure = 'pull';
        try {
            await expect(updateStack(trigger, [container])).rejects.toThrow(
                'manual recovery is required',
            );
            expect(write).toHaveBeenCalledTimes(2);
            expect(
                yaml.parse(await fs.readFile(file, 'utf8')).services.web.image,
            ).toBe('example/web:2');
            expect(HookManager.runFailureHooks).toHaveBeenCalledTimes(1);
            expect(HookManager.runPostHooks).not.toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });
    test('refuses interpolated or unresolved image declarations before mutation', async () => {
        await fs.writeFile(
            file,
            'services:\n  web:\n    image: ${WEB_IMAGE}\n',
        );
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'Interpolated',
        );
        expect(await fs.readFile(file, 'utf8')).toContain('${WEB_IMAGE}');
        (trigger.mapCurrentVersionToUpdateVersion as jest.Mock).mockReturnValue(
            undefined,
        );
        await expect(updateStack(trigger, [container])).rejects.toThrow(
            'updated image',
        );
    });
});
