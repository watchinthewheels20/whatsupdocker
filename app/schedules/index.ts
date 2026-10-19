import cron, { ScheduledTask } from 'node-cron';
import joi from 'joi';
import * as store from './store';
import {
    resolveTarget,
    runUpdates,
    resumeUpdates,
    stopUpdates,
} from '../updates/service';
import { messageOf, UpdateResult } from '../updates/model';
import logger from '../log';
const log = logger.child({ component: 'schedules' });
const tasks = new Map<string, ScheduledTask>();
const active = new Set<string>();
let started = false;
let stopping = false;
const executions = new Set<Promise<{ results: UpdateResult[] }>>();

export const scheduleSchema = joi
    .object({
        name: joi.string().trim().max(100).required(),
        containerId: joi.string().max(256),
        triggerId: joi.string().max(200).required(),
        scope: joi.string().valid('container', 'stack').required(),
        cron: joi
            .string()
            .max(100)
            .required()
            .custom((value: string, helpers) =>
                value.trim().split(/\s+/).length === 5 && cron.validate(value)
                    ? value
                    : helpers.error('any.invalid'),
            ),
        timezone: joi
            .string()
            .max(100)
            .default('Europe/London')
            .custom((value: string, helpers) => {
                try {
                    new Intl.DateTimeFormat('en', { timeZone: value }).format();
                    return value;
                } catch {
                    return helpers.error('any.invalid');
                }
            }),
        enabled: joi.boolean().default(true),
    })
    .unknown(false);

export function describeSchedule(schedule: store.Schedule) {
    return {
        ...schedule,
        nextRunAt: schedule.enabled
            ? tasks.get(schedule.id)?.getNextRun()?.toISOString() || null
            : null,
    };
}
export function refreshSchedule(schedule: store.Schedule) {
    tasks.get(schedule.id)?.destroy();
    tasks.delete(schedule.id);
    if (started && schedule.enabled) {
        const task = cron.schedule(
            schedule.cron,
            async () => {
                if (!started || !store.getSchedule(schedule.id)?.enabled)
                    return;
                try {
                    await runSchedule(schedule.id);
                } catch (error) {
                    log.error(`Scheduled update failed: ${messageOf(error)}`);
                }
            },
            { timezone: schedule.timezone, noOverlap: true },
        );
        tasks.set(schedule.id, task);
    }
}
export function removeTask(id: string) {
    tasks.get(id)?.destroy();
    tasks.delete(id);
}
async function executeSchedule(
    id: string,
): Promise<{ results: UpdateResult[] }> {
    if (stopping) throw new Error('Schedule service is stopping');
    const schedule = store.getSchedule(id);
    if (!schedule) throw new Error('Schedule not found');
    if (active.has(id)) throw new Error('Schedule is already running');
    active.add(id);
    const lastRunAt = new Date().toISOString();
    store.saveSchedule({
        ...schedule,
        lastRunAt,
        lastStatus: 'running',
        lastError: null,
    });
    let lastStatus: store.Schedule['lastStatus'] = 'failed';
    let lastError: string | null = null;
    try {
        const containers = await resolveTarget(schedule.target, schedule.scope);
        const result = await runUpdates(
            {
                containerIds: containers.map((container) => container.id),
                triggerId: schedule.triggerId,
                scope: schedule.scope,
            },
            containers,
        );
        lastStatus = result.results.some((item) => item.status === 'failed')
            ? 'failed'
            : result.results.some((item) => item.status === 'updated')
              ? 'updated'
              : 'skipped';
        lastError =
            result.results
                .filter((item) => item.status === 'failed')
                .map((item) => item.message)
                .join('; ') || null;
        return result;
    } catch (error) {
        lastError = messageOf(error);
        throw error;
    } finally {
        active.delete(id);
        // Preserve concurrent edits/pause and never resurrect a deleted record.
        const latest = store.getSchedule(id);
        if (latest)
            store.saveSchedule({ ...latest, lastRunAt, lastStatus, lastError });
    }
}
export function runSchedule(id: string): Promise<{ results: UpdateResult[] }> {
    const execution = executeSchedule(id);
    executions.add(execution);
    void execution
        .finally(() => executions.delete(execution))
        .catch(() => undefined);
    return execution;
}
export function startSchedules() {
    stopping = false;
    started = true;
    resumeUpdates();
    for (const schedule of store.listSchedules()) {
        const recovered =
            schedule.lastStatus === 'running'
                ? store.saveSchedule({
                      ...schedule,
                      lastStatus: 'failed',
                      lastError: 'Previous run interrupted by process restart',
                  })
                : schedule;
        refreshSchedule(recovered);
    }
}
export async function stopSchedules() {
    started = false;
    stopping = true;
    for (const id of tasks.keys()) removeTask(id);
    await Promise.allSettled([...executions]);
    await stopUpdates();
}
