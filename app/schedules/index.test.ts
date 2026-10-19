import cron from 'node-cron';
import * as store from './store';
import * as updates from '../updates/service';
import {
    scheduleSchema,
    runSchedule,
    startSchedules,
    stopSchedules,
    describeSchedule,
} from './index';
import { Container } from '../model/container';
jest.mock('node-cron', () => ({
    __esModule: true,
    default: { validate: jest.fn(() => true), schedule: jest.fn() },
}));
jest.mock('./store', () => ({
    getSchedule: jest.fn(),
    saveSchedule: jest.fn(),
    listSchedules: jest.fn(),
}));
jest.mock('../updates/service', () => ({
    resolveTarget: jest.fn(),
    runUpdates: jest.fn(),
    resumeUpdates: jest.fn(),
    stopUpdates: jest.fn(),
}));
const initial: store.Schedule = {
    id: 'schedule',
    name: 'web',
    target: { watcher: 'local', name: 'web' },
    triggerId: 'docker.local',
    scope: 'container',
    cron: '0 2 * * *',
    timezone: 'Europe/London',
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
};
describe('persistent scheduler', () => {
    let current: store.Schedule | undefined;
    const destroy = jest.fn();
    beforeEach(() => {
        jest.clearAllMocks();
        current = { ...initial };
        (store.getSchedule as jest.Mock).mockImplementation(() => current);
        (store.saveSchedule as jest.Mock).mockImplementation((schedule) => {
            current = schedule;
            return schedule;
        });
        (store.listSchedules as jest.Mock).mockImplementation(() =>
            current ? [current] : [],
        );
        (updates.resolveTarget as jest.Mock).mockResolvedValue([
            { id: 'replacement' } as Container,
        ]);
        (updates.runUpdates as jest.Mock).mockResolvedValue({
            results: [{ id: 'replacement', name: 'web', status: 'updated' }],
        });
        (cron.schedule as jest.Mock).mockReturnValue({
            destroy,
            getNextRun: () => new Date('2030-01-01T00:00:00Z'),
        });
        startSchedules();
    });
    afterEach(async () => {
        await stopSchedules();
    });
    test('validates cron, timezone and unknown keys and supplies defaults', () => {
        const input = {
            name: 'web',
            triggerId: 'docker.local',
            scope: 'container',
            cron: '0 2 * * *',
        };
        expect(scheduleSchema.validate(input).value).toMatchObject({
            enabled: true,
            timezone: 'Europe/London',
        });
        expect(
            scheduleSchema.validate({ ...input, timezone: 'Nowhere/Invalid' })
                .error,
        ).toBeDefined();
        expect(
            scheduleSchema.validate({ ...input, unexpected: true }).error,
        ).toBeDefined();
        (cron.validate as jest.Mock).mockReturnValueOnce(false);
        expect(
            scheduleSchema.validate({ ...input, cron: 'invalid' }).error,
        ).toBeDefined();
    });
    test('resolves stable target at run time and stores completion', async () => {
        await runSchedule('schedule');
        expect(updates.resolveTarget).toHaveBeenCalledWith(
            initial.target,
            'container',
        );
        expect(updates.runUpdates).toHaveBeenCalledWith(
            {
                containerIds: ['replacement'],
                triggerId: 'docker.local',
                scope: 'container',
            },
            [{ id: 'replacement' }],
        );
        expect(current).toMatchObject({
            lastStatus: 'updated',
            lastError: null,
            lastRunAt: expect.any(String),
        });
    });
    test('aggregates failed results and records rejected target discovery', async () => {
        (updates.runUpdates as jest.Mock).mockResolvedValueOnce({
            results: [
                { status: 'failed', message: 'offline' },
                { status: 'updated' },
            ],
        });
        await runSchedule('schedule');
        expect(current).toMatchObject({
            lastStatus: 'failed',
            lastError: 'offline',
        });
        (updates.resolveTarget as jest.Mock).mockRejectedValueOnce(
            new Error('gone'),
        );
        await expect(runSchedule('schedule')).rejects.toThrow('gone');
        expect(current).toMatchObject({
            lastStatus: 'failed',
            lastError: 'gone',
        });
    });
    test('preserves pause/edit during execution and never resurrects deletion', async () => {
        (updates.runUpdates as jest.Mock).mockImplementationOnce(async () => {
            current = { ...current!, name: 'renamed', enabled: false };
            return { results: [{ status: 'skipped' }] };
        });
        await runSchedule('schedule');
        expect(current).toMatchObject({
            name: 'renamed',
            enabled: false,
            lastStatus: 'skipped',
        });
        (updates.runUpdates as jest.Mock).mockImplementationOnce(async () => {
            current = undefined;
            return { results: [] };
        });
        await runSchedule('schedule');
        expect(current).toBeUndefined();
        await expect(runSchedule('schedule')).rejects.toThrow('not found');
    });
    test('drains discovery already in progress before stopping updates and rejects overlapping runs', async () => {
        let finish!: (containers: Container[]) => void;
        (updates.resolveTarget as jest.Mock).mockImplementationOnce(
            () =>
                new Promise<Container[]>((resolve) => {
                    finish = resolve;
                }),
        );
        const execution = runSchedule('schedule');
        await expect(runSchedule('schedule')).rejects.toThrow(
            'already running',
        );
        const shutdown = stopSchedules();
        expect(updates.stopUpdates).not.toHaveBeenCalled();
        await expect(runSchedule('schedule')).rejects.toThrow('stopping');
        finish([{ id: 'replacement' } as Container]);
        await execution;
        await shutdown;
        expect(updates.stopUpdates).toHaveBeenCalledTimes(1);
        expect(current).toMatchObject({ lastStatus: 'updated' });
    });
    test('ignores queued cron callbacks after a target is paused or deleted', async () => {
        const callback = (cron.schedule as jest.Mock).mock
            .calls[0][1] as () => Promise<void>;
        current = { ...initial, enabled: false };
        await callback();
        current = undefined;
        await callback();
        expect(updates.resolveTarget).not.toHaveBeenCalled();
    });
    test('recovers interrupted runs on startup and destroys timers on shutdown', async () => {
        current = { ...initial, lastStatus: 'running' };
        startSchedules();
        expect(current).toMatchObject({
            lastStatus: 'failed',
            lastError: expect.stringContaining('restart'),
        });
        expect(describeSchedule(current!).nextRunAt).toBe(
            '2030-01-01T00:00:00.000Z',
        );
        await stopSchedules();
        expect(destroy).toHaveBeenCalled();
        expect(updates.stopUpdates).toHaveBeenCalled();
    });
});
