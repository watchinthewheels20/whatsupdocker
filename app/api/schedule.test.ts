import express from 'express';
import request from 'supertest';
import { init } from './schedule';
import * as store from '../schedules/store';
import * as scheduler from '../schedules';
import * as registry from '../registry';
import * as containers from '../store/container';
import { getAssociatedTriggerIds } from '../triggers/associatedTriggers';
jest.mock('../registry', () => ({ getState: jest.fn() }));
jest.mock('../store/container', () => ({ getContainer: jest.fn() }));
jest.mock('../updates/service', () => ({
    getOptions: jest.fn(),
    runUpdates: jest.fn(),
}));
jest.mock('../schedules/store', () => ({
    listSchedules: jest.fn(),
    getSchedule: jest.fn(),
    createSchedule: jest.fn(),
    saveSchedule: jest.fn(),
    deleteSchedule: jest.fn(),
}));
jest.mock('../schedules', () => ({
    ...jest.requireActual('../schedules'),
    refreshSchedule: jest.fn(),
    removeTask: jest.fn(),
    runSchedule: jest.fn(),
    describeSchedule: jest.fn((schedule) => schedule),
}));
jest.mock('../triggers/associatedTriggers', () => ({
    getAssociatedTriggerIds: jest.fn(),
    UPDATE_TRIGGER_TYPES: ['docker', 'dockercompose'],
}));
const body = {
    name: 'web',
    containerId: 'old',
    triggerId: 'docker.local',
    scope: 'container',
    cron: '0 2 * * *',
};
const saved = {
    ...body,
    id: 'schedule',
    target: { watcher: 'local', name: 'web' },
    timezone: 'Europe/London',
    enabled: true,
};
function appFor(role = 'rw') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        Object.assign(req, { user: { role } });
        next();
    });
    app.use(init());
    return app;
}
describe('schedule API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (store.listSchedules as jest.Mock).mockReturnValue([saved]);
        (store.getSchedule as jest.Mock).mockReturnValue(saved);
        (store.createSchedule as jest.Mock).mockImplementation((input) => ({
            ...input,
            id: 'schedule',
        }));
        (store.saveSchedule as jest.Mock).mockImplementation((input) => input);
        (store.deleteSchedule as jest.Mock).mockReturnValue(true);
        (containers.getContainer as jest.Mock).mockReturnValue({
            id: 'old',
            name: 'web',
            watcher: 'local',
        });
        (registry.getState as jest.Mock).mockReturnValue({
            trigger: { 'docker.local': { type: 'docker' } },
        });
        (getAssociatedTriggerIds as jest.Mock).mockReturnValue(
            new Set(['docker.local']),
        );
        (scheduler.runSchedule as jest.Mock).mockResolvedValue({ results: [] });
    });
    test('creates stable targets and allows pause without original container ID', async () => {
        const created = await request(appFor()).post('/').send(body);
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            target: saved.target,
            timezone: 'Europe/London',
        });
        const paused = await request(appFor())
            .patch('/schedule')
            .send({ enabled: false });
        expect(paused.status).toBe(200);
        expect(paused.body).toMatchObject({
            enabled: false,
            target: saved.target,
        });
        expect(scheduler.refreshSchedule).toHaveBeenCalledTimes(2);
    });
    test('read-only role can list but cannot mutate, and foreign origins are rejected', async () => {
        expect((await request(appFor('ro')).get('/')).status).toBe(200);
        expect((await request(appFor('ro')).post('/').send(body)).status).toBe(
            403,
        );
        expect(
            (
                await request(appFor())
                    .delete('/schedule')
                    .set('Origin', 'https://evil.test')
            ).status,
        ).toBe(403);
        expect(store.deleteSchedule).not.toHaveBeenCalled();
    });
    test.each([
        { ...body, cron: 'bad' },
        { ...body, timezone: 'Invalid/Zone' },
        { ...body, scope: 'stack' },
        { ...body, unknown: true },
    ])('rejects invalid configuration %p', async (input) => {
        expect((await request(appFor()).post('/').send(input)).status).toBe(
            400,
        );
    });
    test('rejects missing container and excluded updater', async () => {
        (containers.getContainer as jest.Mock).mockReturnValue(undefined);
        expect((await request(appFor()).post('/').send(body)).status).toBe(400);
        (containers.getContainer as jest.Mock).mockReturnValue({
            id: 'old',
            name: 'web',
            watcher: 'local',
        });
        (getAssociatedTriggerIds as jest.Mock).mockReturnValue(new Set());
        expect(
            (await request(appFor()).post('/').send(body)).body.error,
        ).toContain('excluded');
    });
    test('removes timers and returns missing/conflicting run responses', async () => {
        expect((await request(appFor()).delete('/schedule')).status).toBe(204);
        expect(scheduler.removeTask).toHaveBeenCalledWith('schedule');
        (scheduler.runSchedule as jest.Mock).mockRejectedValue(
            new Error('already running'),
        );
        expect(
            (await request(appFor()).post('/schedule/run').send({})).status,
        ).toBe(409);
        (store.getSchedule as jest.Mock).mockReturnValue(undefined);
        expect(
            (await request(appFor()).post('/missing/run').send({})).status,
        ).toBe(404);
        expect(
            (await request(appFor()).patch('/missing').send({ enabled: false }))
                .status,
        ).toBe(404);
    });
});
