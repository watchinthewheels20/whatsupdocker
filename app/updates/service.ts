import * as registry from '../registry';
import * as store from '../store/container';
import { Container } from '../model/container';
import {
    getAssociatedTriggerIds,
    UPDATE_TRIGGER_TYPES,
} from '../triggers/associatedTriggers';
import Dockercompose from '../triggers/providers/dockercompose/Dockercompose';
import { planStack, updateStack } from './compose';
import { withUpdateLock } from './lock';
import {
    UpdateRequest,
    UpdateResult,
    UpdateTarget,
    matchesTarget,
    stackId,
    messageOf,
} from './model';

const activeTargets = new Set<string>();
let accepting = true;
const running = new Set<Promise<unknown>>();
export function resumeUpdates() {
    accepting = true;
}
export async function stopUpdates() {
    accepting = false;
    await Promise.allSettled([...running]);
}
function watcherFor(container: Container) {
    const watcher = registry.getState().watcher[`docker.${container.watcher}`];
    if (!watcher)
        throw new Error(`Docker watcher ${container.watcher} is unavailable`);
    return watcher;
}
export async function resolveTarget(
    target: UpdateTarget,
    scope: 'container' | 'stack',
): Promise<Container[]> {
    const watcher = registry.getState().watcher[`docker.${target.watcher}`];
    if (!watcher)
        throw new Error(`Docker watcher ${target.watcher} is unavailable`);
    const containers = await watcher.getContainers();
    const found = containers.filter((container) =>
        scope === 'stack' && target.composeProject
            ? container.labels?.['com.docker.compose.project'] ===
              target.composeProject
            : matchesTarget(container, target),
    );
    if (!found.length) throw new Error('Scheduled target no longer exists');
    if (scope === 'container' && found.length > 1)
        throw new Error(
            'Scheduled container target is ambiguous; use a stack schedule',
        );
    return found;
}
function assertAllowed(container: Container, triggerId: string) {
    if (!getAssociatedTriggerIds(container).has(triggerId))
        throw new Error(
            `Trigger ${triggerId} is excluded for ${container.name}`,
        );
    if (container.isSnoozed)
        throw new Error(`Updates are snoozed for ${container.name}`);
    if (
        container.isCoolingDown ||
        (container.coolingDownUntil && container.coolingDownUntil > Date.now())
    )
        throw new Error(`Update delay is active for ${container.name}`);
}

export async function getOptions() {
    const triggers = Object.entries(registry.getState().trigger)
        .filter(([, trigger]) => UPDATE_TRIGGER_TYPES.includes(trigger.type))
        .map(([id, trigger]) => ({
            id,
            type: trigger.type,
            name: trigger.name,
            dryrun: trigger.configuration.dryrun === true,
        }));
    const groups = new Map<string, Container[]>();
    for (const container of store.getContainers()) {
        const id = stackId(container);
        if (id) groups.set(id, [...(groups.get(id) || []), container]);
    }
    const stacks = await Promise.all(
        [...groups].map(async ([id, containers]) => {
            const result = {
                id,
                name: containers[0].labels!['com.docker.compose.project'],
                watcher: containers[0].watcher,
                containerIds: containers.map((container) => container.id),
                composeFiles: [] as string[],
                available: false,
                reason: 'No authorized Docker Compose updater is configured',
            };
            for (const [triggerId, trigger] of Object.entries(
                registry.getState().trigger,
            )) {
                if (
                    !(trigger instanceof Dockercompose) ||
                    !containers.every((container) =>
                        getAssociatedTriggerIds(container).has(triggerId),
                    )
                )
                    continue;
                try {
                    result.composeFiles = (
                        await planStack(trigger, containers[0])
                    ).files;
                    result.available = true;
                    result.reason = '';
                    break;
                } catch (error) {
                    result.reason = messageOf(error);
                }
            }
            return result;
        }),
    );
    return { triggers, stacks };
}

async function perform(
    request: UpdateRequest,
    supplied?: Container[],
): Promise<{ results: UpdateResult[] }> {
    if (!accepting) throw new Error('Update service is stopping');
    const trigger = registry.getState().trigger[request.triggerId];
    if (!trigger || !UPDATE_TRIGGER_TYPES.includes(trigger.type))
        throw new Error('Choose a configured update-capable trigger');
    if (request.scope === 'stack' && !(trigger instanceof Dockercompose))
        throw new Error('Whole-stack updates require a Docker Compose trigger');
    const selected =
        supplied || request.containerIds.map((id) => store.getContainer(id));
    const results: UpdateResult[] = [];
    const done = new Set<string>();
    for (let index = 0; index < selected.length; index++) {
        const original = selected[index];
        const id = original?.id || request.containerIds[index];
        const name = original?.name || id;
        if (!original) {
            results.push({
                id,
                name,
                status: 'failed',
                message: 'Container not found',
            });
            continue;
        }
        const key = stackId(original) || `${original.watcher}:${original.name}`;
        const dedupeKey = request.scope === 'stack' ? key : original.id;
        if (done.has(dedupeKey)) {
            results.push({
                id,
                name,
                status: 'skipped',
                message: 'Already included in this update',
            });
            continue;
        }
        done.add(dedupeKey);
        if (activeTargets.has(key)) {
            results.push({
                id,
                name,
                status: 'skipped',
                message: 'An update for this target is already running',
            });
            continue;
        }
        activeTargets.add(key);
        try {
            const outcome = await withUpdateLock(
                [original],
                async (): Promise<UpdateResult> => {
                    const watcher = watcherFor(original);
                    const live = await watcher.getContainers();
                    const candidates =
                        request.scope === 'stack'
                            ? live.filter(
                                  (container) =>
                                      stackId(container) ===
                                          stackId(original) &&
                                      !!stackId(original),
                              )
                            : live.filter(
                                  (container) => container.id === original.id,
                              );
                    if (!candidates.length)
                        throw new Error(
                            'Container target is no longer running',
                        );
                    const checked: Container[] = [];
                    for (const candidate of candidates) {
                        const report = (await watcher.watchContainer(
                            candidate,
                            { emitReport: false },
                        )) as { container: Container };
                        if (!report?.container)
                            throw new Error(
                                'Watcher did not return a container report',
                            );
                        if (report.container.error)
                            throw new Error(report.container.error.message);
                        assertAllowed(report.container, request.triggerId);
                        checked.push(report.container);
                    }
                    if (trigger.configuration.dryrun)
                        return {
                            id,
                            name,
                            status: 'skipped',
                            message: 'Updater is configured for dry run',
                        };
                    if (!checked.some((container) => container.updateAvailable))
                        return {
                            id,
                            name,
                            status: 'skipped',
                            message: 'No update available',
                        };
                    if (request.scope === 'stack')
                        await updateStack(trigger as Dockercompose, checked);
                    else {
                        if (trigger instanceof Dockercompose)
                            await planStack(trigger, checked[0]);
                        await trigger.trigger(checked[0]);
                    }
                    return { id, name, status: 'updated' };
                },
            );
            results.push(outcome);
        } catch (error) {
            results.push({
                id,
                name,
                status: 'failed',
                message: messageOf(error),
            });
        } finally {
            activeTargets.delete(key);
        }
    }
    return { results };
}
export function runUpdates(request: UpdateRequest, supplied?: Container[]) {
    const execution = perform(request, supplied);
    running.add(execution);
    void execution
        .finally(() => running.delete(execution))
        .catch(() => undefined);
    return execution;
}
