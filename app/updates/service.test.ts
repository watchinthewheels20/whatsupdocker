import Dockercompose from '../triggers/providers/dockercompose/Dockercompose';
import { updateStack } from './compose';
import { Container } from '../model/container';
import * as registry from '../registry';
import * as store from '../store/container';
import { getAssociatedTriggerIds } from '../triggers/associatedTriggers';
import {
    resolveTarget,
    runUpdates,
    resumeUpdates,
    stopUpdates,
} from './service';
jest.mock('../registry', () => ({ getState: jest.fn() }));
jest.mock('../store/container', () => ({
    getContainer: jest.fn(),
    getContainers: jest.fn(),
}));
jest.mock('../triggers/associatedTriggers', () => ({
    getAssociatedTriggerIds: jest.fn(),
    UPDATE_TRIGGER_TYPES: ['docker', 'dockercompose'],
}));
jest.mock('./compose', () => ({
    planStack: jest.fn(),
    updateStack: jest.fn(),
}));
jest.mock('../triggers/providers/dockercompose/Dockercompose', () => ({
    __esModule: true,
    default: class Dockercompose {},
}));
const makeContainer = (id: string, values = {}) =>
    ({
        id,
        name: id,
        watcher: 'local',
        updateAvailable: true,
        ...values,
    }) as Container;
describe('update runner', () => {
    let containers: Container[];
    const trigger = {
        type: 'docker',
        configuration: { dryrun: false },
        trigger: jest.fn(),
    };
    const watcher = { getContainers: jest.fn(), watchContainer: jest.fn() };
    const request = (containerIds = ['one']) => ({
        containerIds,
        triggerId: 'docker.local',
        scope: 'container' as const,
    });
    beforeEach(() => {
        jest.resetAllMocks();
        resumeUpdates();
        containers = [makeContainer('one'), makeContainer('two')];
        trigger.configuration.dryrun = false;
        (registry.getState as jest.Mock).mockReturnValue({
            watcher: { 'docker.local': watcher },
            trigger: { 'docker.local': trigger },
        });
        (store.getContainer as jest.Mock).mockImplementation((id) =>
            containers.find((container) => container.id === id),
        );
        (getAssociatedTriggerIds as jest.Mock).mockReturnValue(
            new Set(['docker.local']),
        );
        watcher.getContainers.mockImplementation(async () => containers);
        watcher.watchContainer.mockImplementation(async (container) => ({
            container,
        }));
        trigger.trigger.mockResolvedValue(undefined);
    });
    test('continues mixed batches, deduplicates IDs, refreshes silently', async () => {
        trigger.trigger.mockRejectedValueOnce(new Error('daemon failed'));
        const result = await runUpdates(
            request(['one', 'missing', 'two', 'two']),
        );
        expect(result.results.map((item) => item.status)).toEqual([
            'failed',
            'failed',
            'updated',
            'skipped',
        ]);
        expect(watcher.watchContainer).toHaveBeenCalledWith(containers[0], {
            emitReport: false,
        });
        expect(trigger.trigger).toHaveBeenCalledTimes(2);
    });
    test.each([
        [{ updateAvailable: false }, 'skipped', 'No update available'],
        [{ isSnoozed: true }, 'failed', 'snoozed'],
        [{ isCoolingDown: true }, 'failed', 'delay'],
        [
            { error: { message: 'registry offline' } },
            'failed',
            'registry offline',
        ],
    ])('checks refreshed eligibility %p', async (values, status, message) => {
        watcher.watchContainer.mockResolvedValue({
            container: makeContainer('one', values),
        });
        expect((await runUpdates(request())).results[0]).toMatchObject({
            status,
            message: expect.stringContaining(message),
        });
        expect(trigger.trigger).not.toHaveBeenCalled();
    });
    test('honors dry-run and exclusions', async () => {
        trigger.configuration.dryrun = true;
        expect((await runUpdates(request())).results[0].status).toBe('skipped');
        (getAssociatedTriggerIds as jest.Mock).mockReturnValue(new Set());
        expect((await runUpdates(request())).results[0].message).toContain(
            'excluded',
        );
        expect(trigger.trigger).not.toHaveBeenCalled();
    });
    test('rejects unavailable updaters, wrong stack updater, and stopped execution', async () => {
        await expect(
            runUpdates({ ...request(), triggerId: 'missing' }),
        ).rejects.toThrow('update-capable');
        await expect(
            runUpdates({ ...request(), scope: 'stack' }),
        ).rejects.toThrow('Compose');
        await stopUpdates();
        await expect(runUpdates(request())).rejects.toThrow('stopping');
    });
    test('updates each stack once, checking all live members before execution', async () => {
        const compose = Object.assign(new Dockercompose(), {
            type: 'dockercompose',
            configuration: { dryrun: false },
        });
        (registry.getState as jest.Mock).mockReturnValue({
            watcher: { 'docker.local': watcher },
            trigger: { 'docker.local': compose },
        });
        const labels = { 'com.docker.compose.project': 'demo' };
        containers = [
            makeContainer('one', { labels }),
            makeContainer('two', { labels, updateAvailable: false }),
        ];
        const result = await runUpdates({
            ...request(['one', 'two']),
            scope: 'stack',
        });
        expect(result.results.map((item) => item.status)).toEqual([
            'updated',
            'skipped',
        ]);
        expect(watcher.watchContainer).toHaveBeenCalledTimes(2);
        expect(updateStack).toHaveBeenCalledWith(compose, containers);
        expect(updateStack).toHaveBeenCalledTimes(1);
    });
    test('does not update a whole stack when any member excludes the trigger', async () => {
        const compose = Object.assign(new Dockercompose(), {
            type: 'dockercompose',
            configuration: { dryrun: false },
        });
        (registry.getState as jest.Mock).mockReturnValue({
            watcher: { 'docker.local': watcher },
            trigger: { 'docker.local': compose },
        });
        const labels = { 'com.docker.compose.project': 'demo' };
        containers = [
            makeContainer('one', { labels }),
            makeContainer('two', { labels }),
        ];
        (getAssociatedTriggerIds as jest.Mock).mockImplementation(
            (container) =>
                new Set(container.id === 'one' ? ['docker.local'] : []),
        );
        expect(
            (await runUpdates({ ...request(), scope: 'stack' })).results[0]
                .status,
        ).toBe('failed');
        expect(updateStack).not.toHaveBeenCalled();
    });
    test('resolves stable names and refuses ambiguity', async () => {
        containers = [makeContainer('new-id', { name: 'web' })];
        await expect(
            resolveTarget({ watcher: 'local', name: 'web' }, 'container'),
        ).resolves.toEqual(containers);
        containers.push(makeContainer('replica', { name: 'web' }));
        await expect(
            resolveTarget({ watcher: 'local', name: 'web' }, 'container'),
        ).rejects.toThrow('ambiguous');
        await expect(
            resolveTarget({ watcher: 'local', name: 'absent' }, 'container'),
        ).rejects.toThrow('no longer exists');
        await expect(
            resolveTarget({ watcher: 'remote', name: 'web' }, 'container'),
        ).rejects.toThrow('unavailable');
    });
});
