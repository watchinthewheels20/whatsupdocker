import { AsyncLocalStorage } from 'node:async_hooks';
import { Container } from '../model/container';

type LockTarget = Pick<Container, 'watcher' | 'name' | 'id' | 'labels'>;

type LockMode = 'shared' | 'exclusive';
interface HeldLock {
    token: symbol;
    mode: LockMode;
}
const ownership = new AsyncLocalStorage<ReadonlyMap<string, HeldLock>>();
const active = new Map<string, Map<symbol, LockMode>>();

function resources(
    containers: LockTarget[],
    scope: 'project' | 'container',
): Map<string, LockMode> {
    const result = new Map<string, LockMode>();
    for (const container of containers) {
        const project = container.labels?.['com.docker.compose.project'];
        if (project)
            result.set(
                JSON.stringify([container.watcher, 'project', project]),
                scope === 'project' ? 'exclusive' : 'shared',
            );
        if (!project || scope === 'container')
            result.set(
                JSON.stringify([
                    container.watcher,
                    'container',
                    container.name || container.id,
                ]),
                'exclusive',
            );
    }
    return result;
}

/**
 * Coordinate manual, scheduled and automatic updates to the same project.
 * Nested Compose -> Docker calls inherit ownership. Unrelated callers fail
 * immediately instead of queuing container snapshots that may become stale.
 * Individual Docker updates share the project guard so automatic updates to
 * different services can proceed together, while whole-project work is exclusive.
 */
export async function withUpdateLock<T>(
    containers: LockTarget[],
    task: () => Promise<T>,
    scope: 'project' | 'container' = 'project',
): Promise<T> {
    const inherited = ownership.getStore() || new Map<string, HeldLock>();
    const required = [...resources(containers, scope)].filter(([key, mode]) => {
        const held = inherited.get(key);
        return (
            !held ||
            active.get(key)?.get(held.token) !== held.mode ||
            (mode === 'exclusive' && held.mode !== 'exclusive')
        );
    });
    if (
        required.some(([key, mode]) => {
            const holders = active.get(key);
            return (
                holders?.size &&
                (mode === 'exclusive' ||
                    [...holders.values()].includes('exclusive'))
            );
        })
    ) {
        throw new Error(
            'An update for this container or Compose project is already running',
        );
    }

    // No await between checking and claiming: claim all targets atomically.
    const token = Symbol('update');
    for (const [key, mode] of required) {
        const holders = active.get(key) || new Map<symbol, LockMode>();
        holders.set(token, mode);
        active.set(key, holders);
    }
    try {
        return await ownership.run(
            new Map([
                ...inherited,
                ...required.map(([key, mode]): [string, HeldLock] => [
                    key,
                    { token, mode },
                ]),
            ]),
            task,
        );
    } finally {
        for (const [key] of required) {
            const holders = active.get(key)!;
            holders.delete(token);
            if (!holders.size) active.delete(key);
        }
    }
}
