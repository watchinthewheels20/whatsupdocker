import { Container } from '../model/container';

export type UpdateScope = 'container' | 'stack';
export interface UpdateTarget {
    watcher: string;
    name: string;
    composeProject?: string;
    composeService?: string;
}
export interface UpdateRequest {
    containerIds: string[];
    triggerId: string;
    scope: UpdateScope;
}
export interface UpdateResult {
    id: string;
    name: string;
    status: 'updated' | 'skipped' | 'failed';
    message?: string;
}
export function targetFor(container: Container): UpdateTarget {
    return {
        watcher: container.watcher,
        name: container.name,
        composeProject: container.labels?.['com.docker.compose.project'],
        composeService: container.labels?.['com.docker.compose.service'],
    };
}
export function matchesTarget(
    container: Container,
    target: UpdateTarget,
): boolean {
    if (container.watcher !== target.watcher) return false;
    if (target.composeProject && target.composeService) {
        return (
            container.labels?.['com.docker.compose.project'] ===
                target.composeProject &&
            container.labels?.['com.docker.compose.service'] ===
                target.composeService
        );
    }
    return container.name === target.name;
}
export function stackId(container: Container): string | undefined {
    const project = container.labels?.['com.docker.compose.project'];
    return project ? `${container.watcher}:${project}` : undefined;
}
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
