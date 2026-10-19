import express from 'express';
import * as registry from '../registry';
import * as containers from '../store/container';
import * as store from '../schedules/store';
import {
    scheduleSchema,
    describeSchedule,
    refreshSchedule,
    removeTask,
    runSchedule,
} from '../schedules';
import { targetFor, messageOf } from '../updates/model';
import {
    getAssociatedTriggerIds,
    UPDATE_TRIGGER_TYPES,
} from '../triggers/associatedTriggers';
import { requireRole } from './rbac';
import { requireSameOrigin } from './updates';

function input(
    body: Record<string, unknown>,
    existing?: store.Schedule,
): store.ScheduleInput {
    const merged = {
        ...(existing
            ? {
                  name: existing.name,
                  triggerId: existing.triggerId,
                  scope: existing.scope,
                  cron: existing.cron,
                  timezone: existing.timezone,
                  enabled: existing.enabled,
              }
            : {}),
        ...body,
    };
    const validated = scheduleSchema.validate(merged);
    if (validated.error) throw new Error(validated.error.message);
    const value = validated.value as Omit<store.ScheduleInput, 'target'> & {
        containerId?: string;
    };
    const container = value.containerId
        ? containers.getContainer(value.containerId)
        : undefined;
    if (value.containerId && !container) throw new Error('Container not found');
    const target = container ? targetFor(container) : existing?.target;
    if (!target) throw new Error('containerId is required');
    if (value.scope === 'stack' && !target.composeProject)
        throw new Error('A Compose project target is required');
    const trigger = registry.getState().trigger[value.triggerId];
    if (!trigger || !UPDATE_TRIGGER_TYPES.includes(trigger.type))
        throw new Error('Choose a configured update-capable trigger');
    if (value.scope === 'stack' && trigger.type !== 'dockercompose')
        throw new Error(
            'Whole-stack schedules require a Docker Compose trigger',
        );
    if (container && !getAssociatedTriggerIds(container).has(value.triggerId))
        throw new Error('Trigger is excluded for this container');
    return {
        name: value.name,
        target,
        triggerId: value.triggerId,
        scope: value.scope,
        cron: value.cron,
        timezone: value.timezone,
        enabled: value.enabled,
    };
}
export function init() {
    const router = express.Router();
    router.get('/', requireRole(['admin', 'rw', 'ro'], 'read'), (_req, res) =>
        res.json(store.listSchedules().map(describeSchedule)),
    );
    router.post(
        '/',
        requireRole(['admin', 'rw'], 'write'),
        requireSameOrigin,
        (req, res) => {
            try {
                const schedule = store.createSchedule(input(req.body));
                refreshSchedule(schedule);
                return res.status(201).json(describeSchedule(schedule));
            } catch (error) {
                return res.status(400).json({ error: messageOf(error) });
            }
        },
    );
    const edit: express.RequestHandler = (req, res) => {
        const existing = store.getSchedule(req.params.id as string);
        if (!existing) {
            res.sendStatus(404);
            return;
        }
        try {
            const schedule = store.saveSchedule({
                ...existing,
                ...input(req.body, existing),
            });
            refreshSchedule(schedule);
            res.json(describeSchedule(schedule));
        } catch (error) {
            res.status(400).json({ error: messageOf(error) });
        }
    };
    router.put(
        '/:id',
        requireRole(['admin', 'rw'], 'write'),
        requireSameOrigin,
        edit,
    );
    router.patch(
        '/:id',
        requireRole(['admin', 'rw'], 'write'),
        requireSameOrigin,
        edit,
    );
    router.delete(
        '/:id',
        requireRole(['admin', 'rw'], 'write'),
        requireSameOrigin,
        (req, res) => {
            if (!store.deleteSchedule(req.params.id as string))
                return res.sendStatus(404);
            removeTask(req.params.id as string);
            return res.sendStatus(204);
        },
    );
    router.post(
        '/:id/run',
        requireRole(['admin', 'rw'], 'write'),
        requireSameOrigin,
        async (req, res) => {
            if (!store.getSchedule(req.params.id as string))
                return res.sendStatus(404);
            try {
                return res.json(await runSchedule(req.params.id as string));
            } catch (error) {
                return res.status(409).json({ error: messageOf(error) });
            }
        },
    );
    return router;
}
