import { Container } from '../model/container';
import Docker from '../triggers/providers/docker/Docker';
import Dockercompose from '../triggers/providers/dockercompose/Dockercompose';
import { withUpdateLock } from './lock';

function container(
    name: string,
    project?: string,
    watcher = 'local',
): Container {
    return {
        id: `${name}-id`,
        name,
        watcher,
        labels: project ? { 'com.docker.compose.project': project } : {},
    } as Container;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('shared update ownership', () => {
    test('blocks other services in the same project while allowing other watchers and projects', async () => {
        const release = deferred();
        const first = withUpdateLock(
            [container('web', 'stack')],
            () => release.promise,
        );
        try {
            await expect(
                withUpdateLock(
                    [container('db', 'stack')],
                    async () => undefined,
                ),
            ).rejects.toThrow('already running');
            await expect(
                withUpdateLock(
                    [container('web', 'other')],
                    async () => 'other',
                ),
            ).resolves.toBe('other');
            await expect(
                withUpdateLock(
                    [container('web', 'stack', 'remote')],
                    async () => 'remote',
                ),
            ).resolves.toBe('remote');
        } finally {
            release.resolve();
            await first;
        }
    });

    test('uses a stable container name without Compose labels', async () => {
        const target = container('standalone');
        const release = deferred();
        const first = withUpdateLock([target], () => release.promise);
        try {
            await expect(
                withUpdateLock(
                    [{ ...target, id: 'recreated-id' }],
                    async () => undefined,
                ),
            ).rejects.toThrow('already running');
        } finally {
            release.resolve();
            await first;
        }
    });

    test('reenters inherited ownership and releases it after a failure', async () => {
        const target = container('web', 'nested');
        await expect(
            withUpdateLock([target], () =>
                withUpdateLock([target], async () => {
                    throw new Error('failed');
                }),
            ),
        ).rejects.toThrow('failed');
        await expect(
            withUpdateLock([target], async () => 'released'),
        ).resolves.toBe('released');
    });

    test('does not partially claim targets when one of them conflicts', async () => {
        const blocked = container('busy');
        const free = container('free');
        const release = deferred();
        const first = withUpdateLock([blocked], () => release.promise);
        try {
            await expect(
                withUpdateLock([free, blocked], async () => undefined),
            ).rejects.toThrow('already running');
            await expect(
                withUpdateLock([free], async () => 'free'),
            ).resolves.toBe('free');
        } finally {
            release.resolve();
            await first;
        }
    });

    test('a detached callback cannot reuse expired ownership', async () => {
        const target = container('web', 'detached');
        const resume = deferred();
        let detached!: Promise<unknown>;
        await withUpdateLock([target], async () => {
            detached = resume.promise.then(() =>
                withUpdateLock([target], async () => undefined),
            );
        });
        const release = deferred();
        const second = withUpdateLock([target], () => release.promise);
        const rejected = expect(detached).rejects.toThrow('already running');
        resume.resolve();
        try {
            await rejected;
        } finally {
            release.resolve();
            await second;
        }
    });

    test('legacy Docker trigger respects project ownership and reenters scheduled ownership', async () => {
        const docker = new Docker();
        const perform = jest
            .spyOn(docker, 'performUpdate')
            .mockResolvedValue(undefined);
        const target = container('legacy-web', 'legacy');
        const release = deferred();
        const first = withUpdateLock([target], () => release.promise);
        try {
            await expect(
                docker.trigger(container('legacy-db', 'legacy')),
            ).rejects.toThrow('already running');
            expect(perform).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await first;
        }
        await withUpdateLock([target], () => docker.trigger(target));
        expect(perform).toHaveBeenCalledTimes(1);
    });

    test('legacy Docker batch can update multiple services under inherited ownership', async () => {
        const docker = new Docker();
        const perform = jest
            .spyOn(docker, 'performUpdate')
            .mockResolvedValue(undefined);
        await docker.triggerBatch([
            container('web', 'batch'),
            container('db', 'batch'),
        ]);
        expect(perform).toHaveBeenCalledTimes(2);
    });

    test('automatic Docker updates to sibling services remain concurrent and block native projects', async () => {
        const docker = new Docker();
        const release = deferred();
        const perform = jest
            .spyOn(docker, 'performUpdate')
            .mockImplementation(async () => {
                await release.promise;
                return undefined;
            });
        const web = container('automatic-web', 'automatic');
        const database = container('automatic-db', 'automatic');
        const first = docker.trigger(web);
        const second = docker.trigger(database);
        try {
            expect(perform).toHaveBeenCalledTimes(2);
            await expect(
                withUpdateLock([web], async () => undefined),
            ).rejects.toThrow('already running');
            await expect(docker.trigger(web)).rejects.toThrow(
                'already running',
            );
        } finally {
            release.resolve();
            await Promise.all([first, second]);
        }
        await expect(
            withUpdateLock([web], async () => 'released'),
        ).resolves.toBe('released');
    });

    test('a failed batch retains project ownership until its other service completes', async () => {
        const docker = new Docker();
        const release = deferred();
        jest.spyOn(docker, 'performUpdate')
            .mockRejectedValueOnce(new Error('first service failed'))
            .mockImplementation(async () => {
                await release.promise;
                return undefined;
            });
        const web = container('failed-web', 'failed-batch');
        const database = container('pending-db', 'failed-batch');
        const batch = docker.triggerBatch([web, database]);
        const rejected = expect(batch).rejects.toThrow('first service failed');
        try {
            await Promise.resolve();
            await Promise.resolve();
            await expect(
                withUpdateLock([web], async () => undefined),
            ).rejects.toThrow('already running');
        } finally {
            release.resolve();
            await rejected;
        }
        await expect(
            withUpdateLock([web], async () => 'released'),
        ).resolves.toBe('released');
    });

    test('legacy Compose batch is blocked before it processes a project', async () => {
        const compose = new Dockercompose();
        const release = deferred();
        const target = container('compose-web', 'compose');
        const first = withUpdateLock([target], () => release.promise);
        try {
            await expect(
                compose.triggerBatch([container('compose-db', 'compose')]),
            ).rejects.toThrow('already running');
        } finally {
            release.resolve();
            await first;
        }
        await expect(
            withUpdateLock([target], () => compose.triggerBatch([target])),
        ).resolves.toBeUndefined();
    });
});
