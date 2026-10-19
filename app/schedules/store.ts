import { randomUUID } from 'crypto';
import { getSqlite } from '../store/db';
import { UpdateTarget, UpdateScope } from '../updates/model';

export interface ScheduleInput {
    name: string;
    target: UpdateTarget;
    triggerId: string;
    scope: UpdateScope;
    cron: string;
    timezone: string;
    enabled: boolean;
}
export interface Schedule extends ScheduleInput {
    id: string;
    lastRunAt: string | null;
    lastStatus: 'running' | 'updated' | 'skipped' | 'failed' | null;
    lastError: string | null;
}
export function listSchedules(): Schedule[] {
    const rows = getSqlite()
        .prepare('SELECT document FROM update_schedules ORDER BY id')
        .all() as { document: string }[];
    return rows.map((row) => JSON.parse(row.document) as Schedule);
}
export function getSchedule(id: string): Schedule | undefined {
    const row = getSqlite()
        .prepare('SELECT document FROM update_schedules WHERE id = ?')
        .get(id) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as Schedule) : undefined;
}
export function saveSchedule(schedule: Schedule): Schedule {
    getSqlite()
        .prepare(
            'INSERT INTO update_schedules (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(schedule.id, JSON.stringify(schedule));
    return schedule;
}
export function createSchedule(input: ScheduleInput): Schedule {
    return saveSchedule({
        ...input,
        id: randomUUID(),
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
    });
}
export function deleteSchedule(id: string): boolean {
    return (
        getSqlite().prepare('DELETE FROM update_schedules WHERE id = ?').run(id)
            .changes > 0
    );
}
