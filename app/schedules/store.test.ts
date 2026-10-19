import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, initDatabase, getSqlite } from '../store/db';
import {
    createSchedule,
    deleteSchedule,
    getSchedule,
    listSchedules,
    saveSchedule,
    ScheduleInput,
} from './store';

const input: ScheduleInput = {
    name: 'Nightly web',
    target: { watcher: 'local', name: 'web' },
    triggerId: 'docker.local',
    scope: 'container',
    cron: '0 2 * * *',
    timezone: 'Europe/London',
    enabled: true,
};

describe('SQLite update schedules', () => {
    let directory: string;
    let filename: string;
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'wud-schedules-'));
        filename = join(directory, 'state.db');
        initDatabase(filename);
    });
    afterEach(() => {
        closeDatabase();
        rmSync(directory, { recursive: true, force: true });
    });
    test('migrates a fresh database and supports persisted CRUD', () => {
        expect(listSchedules()).toEqual([]);
        expect(getSchedule('missing')).toBeUndefined();
        expect(deleteSchedule('missing')).toBe(false);
        const created = createSchedule(input);
        expect(created).toMatchObject({
            ...input,
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
        });
        expect(created.id).toMatch(/^[a-f0-9-]{36}$/);
        const changed = {
            ...created,
            enabled: false,
            lastStatus: 'failed' as const,
            lastError: 'offline',
        };
        saveSchedule(changed);
        expect(listSchedules()).toEqual([changed]);
        closeDatabase();
        initDatabase(filename);
        expect(getSchedule(created.id)).toEqual(changed);
        expect(deleteSchedule(created.id)).toBe(true);
        expect(listSchedules()).toEqual([]);
    });
    test('reapplying migrations preserves unrelated data and schedule identities', () => {
        const created = createSchedule(input);
        const tables = getSqlite()
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
        expect(tables).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'update_schedules' }),
            ]),
        );
        closeDatabase();
        initDatabase(filename);
        expect(listSchedules()).toEqual([created]);
    });
});
