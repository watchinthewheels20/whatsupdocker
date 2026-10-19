import express from 'express';
import request from 'supertest';
import { init } from './updates';
import * as service from '../updates/service';
jest.mock('../updates/service', () => ({
    runUpdates: jest.fn(),
    getOptions: jest.fn(),
}));
function appFor(role?: string, scopes?: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (role)
            Object.assign(req, {
                user: { role, ...(scopes ? { token: { scopes } } : {}) },
            });
        next();
    });
    app.use(init());
    return app;
}
const body = {
    containerIds: ['one'],
    triggerId: 'docker.local',
    scope: 'container',
};
describe('bulk update API authorization and validation', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        (service.runUpdates as jest.Mock).mockResolvedValue({ results: [] });
        (service.getOptions as jest.Mock).mockResolvedValue({
            triggers: [],
            stacks: [],
        });
    });
    test.each([
        [undefined, 401],
        ['ro', 403],
        ['rw', 200],
        ['admin', 200],
    ])('enforces role %p', async (role, status) => {
        expect(
            (await request(appFor(role)).post('/run').send(body)).status,
        ).toBe(status);
    });
    test('read-only users may inspect options; tokens require write scope to execute', async () => {
        expect((await request(appFor('ro')).get('/options')).status).toBe(200);
        expect(
            (
                await request(appFor('rw', ['read']))
                    .post('/run')
                    .send(body)
            ).status,
        ).toBe(403);
        expect(
            (
                await request(appFor('rw', ['write']))
                    .post('/run')
                    .send(body)
            ).status,
        ).toBe(200);
    });
    test('rejects cross-origin, malformed-origin and non-JSON mutations', async () => {
        for (const origin of ['https://evil.test', 'invalid']) {
            expect(
                (
                    await request(appFor('rw'))
                        .post('/run')
                        .set('Origin', origin)
                        .send(body)
                ).status,
            ).toBe(403);
        }
        expect(
            (await request(appFor('rw')).post('/run').type('form').send(body))
                .status,
        ).toBe(415);
        expect(service.runUpdates).not.toHaveBeenCalled();
        expect(
            (
                await request(appFor('rw'))
                    .post('/run')
                    .set('Host', 'wud.test')
                    .set('Origin', 'https://wud.test')
                    .send(body)
            ).status,
        ).toBe(200);
    });
    test.each([
        { ...body, containerIds: [] },
        { ...body, containerIds: ['one', 'one'] },
        { ...body, scope: 'all' },
        { ...body, extra: true },
    ])('rejects invalid input %p', async (input) => {
        expect(
            (await request(appFor('rw')).post('/run').send(input)).status,
        ).toBe(400);
        expect(service.runUpdates).not.toHaveBeenCalled();
    });
    test('returns service failures as client errors', async () => {
        (service.runUpdates as jest.Mock).mockRejectedValue(
            new Error('updater unavailable'),
        );
        expect(
            (await request(appFor('rw')).post('/run').send(body)).body,
        ).toEqual({ error: 'updater unavailable' });
        (service.getOptions as jest.Mock).mockRejectedValue(
            new Error('unavailable'),
        );
        expect((await request(appFor('ro')).get('/options')).status).toBe(500);
    });
});
