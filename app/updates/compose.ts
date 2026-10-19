import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { Container } from '../model/container';
import Dockercompose from '../triggers/providers/dockercompose/Dockercompose';
import { projectMutex } from '../triggers/providers/dockercompose/mutex';
import logger from '../log';
import { HookManager } from '../triggers/hooks/HookManager';
import * as event from '../event';
import { isSelfContainer } from '../triggers/providers/docker/self';
const log = logger.child({ component: 'stack-updates' });

interface StackPlan {
    project: string;
    files: string[];
    directory: string;
    socket: string;
}
function inside(file: string, root: string): boolean {
    const relative = path.relative(root, file);
    return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
    );
}
export async function planStack(
    trigger: Dockercompose,
    container: Container,
): Promise<StackPlan> {
    const project = container.labels?.['com.docker.compose.project'];
    if (!project || !/^[a-z0-9][a-z0-9_-]*$/.test(project))
        throw new Error('A valid Compose project label is required');
    const watcher = trigger.getWatcher(container);
    const socket = (
        watcher?.dockerApi?.modem as { socketPath?: string } | undefined
    )?.socketPath;
    if (!socket || !path.isAbsolute(socket))
        throw new Error(
            'Whole-stack updates require a local Docker socket watcher',
        );
    const configured = trigger.configuration.file as string | undefined;
    const mapping = trigger.configuration.pathmapping as
        | { host: string; container: string }
        | undefined;
    if (configured?.includes('${'))
        throw new Error(
            'Whole-stack updates require an explicit Compose file, without templates',
        );
    const discovered = container.labels?.[
        'com.docker.compose.project.config_files'
    ]
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (!discovered?.length)
        throw new Error(
            'Compose config_files labels are required to verify project membership',
        );
    if (!configured && !mapping)
        throw new Error(
            'Configure a Compose trigger file or pathmapping to authorize project files',
        );
    const mapFile = (original: string) => {
        if (!path.isAbsolute(original))
            throw new Error('Compose files must use absolute paths');
        if (mapping) {
            if (!inside(original, path.resolve(mapping.host)))
                throw new Error(
                    'Compose file is outside the configured host path',
                );
            return path.join(
                mapping.container,
                path.relative(mapping.host, original),
            );
        }
        return original;
    };
    const configuredFile = configured
        ? await fs.realpath(mapFile(configured))
        : undefined;
    const authorizedRoot = await fs.realpath(
        mapping ? mapping.container : path.dirname(configuredFile!),
    );
    const files: string[] = [];
    for (const original of discovered) {
        const real = await fs.realpath(mapFile(original));
        if (!inside(real, authorizedRoot))
            throw new Error(
                'Compose file resolves outside the configured mount',
            );
        if (!(await fs.stat(real)).isFile())
            throw new Error('Compose config path must be a regular file');
        files.push(real);
    }
    if (configuredFile && files[0] !== configuredFile)
        throw new Error(
            'Configured Compose file does not match the selected project primary file',
        );
    const originalDirectory =
        container.labels?.['com.docker.compose.project.working_dir'];
    let directory = path.dirname(files[0]);
    if (originalDirectory) {
        if (!path.isAbsolute(originalDirectory))
            throw new Error('Compose working directory must be absolute');
        if (mapping && !inside(originalDirectory, path.resolve(mapping.host)))
            throw new Error(
                'Compose working directory is outside the configured host path',
            );
        directory = await fs.realpath(
            mapping
                ? path.join(
                      mapping.container,
                      path.relative(mapping.host, originalDirectory),
                  )
                : originalDirectory,
        );
        if (!inside(directory, authorizedRoot))
            throw new Error(
                'Compose working directory resolves outside the configured mount',
            );
        if (!mapping && !inside(files[0], directory))
            throw new Error(
                'Compose working directory does not contain the authorized file',
            );
    }
    return { project, files, directory, socket };
}

export function composeCommand(
    plan: StackPlan,
    args: string[],
): Promise<string> {
    // Remove ambient Docker/Compose routing, flags and profile overrides. Preserve
    // ordinary variables for ${...} interpolation and the project's own .env.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) =>
                key === 'DOCKER_CONFIG' || !/^(DOCKER_|COMPOSE_)/.test(key),
        ),
    );
    return new Promise((resolve, reject) => {
        execFile(
            'docker',
            [
                '--host',
                `unix://${plan.socket}`,
                'compose',
                '--project-name',
                plan.project,
                '--project-directory',
                plan.directory,
                ...plan.files.flatMap((file) => ['--file', file]),
                ...args,
            ],
            {
                cwd: plan.directory,
                env,
                timeout: 300000,
                maxBuffer: 4 * 1024 * 1024,
            },
            (error, stdout) => {
                if (error) {
                    log.warn(
                        `Docker Compose ${args[0]} failed (code=${error.code ?? 'unknown'}, signal=${error.signal ?? 'none'})`,
                    );
                    reject(
                        new Error(
                            `Docker Compose ${args[0]} failed; verify project files, registry access, and daemon status`,
                        ),
                    );
                } else resolve(stdout);
            },
        );
    });
}

export async function updateStack(
    trigger: Dockercompose,
    containers: Container[],
): Promise<void> {
    const plan = await planStack(trigger, containers[0]);
    // Native CLI reconciliation has no transaction archive. Fail before mutation
    // rather than silently bypassing a configured rollback guarantee.
    if (
        containers.some(
            (container) => trigger.resolveRollback(container).enabled,
        )
    )
        throw new Error(
            'Native whole-stack reconciliation does not support rollback; use the existing container update action',
        );
    const watcher = trigger.getWatcher(containers[0])!;
    const rawContainers = await watcher.dockerApi.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${plan.project}`] },
    });
    const monitoredIds = new Set(containers.map((container) => container.id));
    if (rawContainers.some((container) => !monitoredIds.has(container.Id)))
        throw new Error(
            'Whole-stack updates require every existing project container to be monitored and policy-checked',
        );
    const ownId = await trigger.resolveSelfContainerId(watcher.dockerApi);
    if (
        rawContainers.some(
            (container) =>
                isSelfContainer(container.Id, ownId) ||
                container.Labels?.['wud.self-update'] === 'true' ||
                container.Labels?.['org.opencontainers.image.title'] ===
                    "What's up Docker?",
        )
    ) {
        throw new Error(
            'Updating the WUD project requires the dedicated self-update workflow',
        );
    }
    return projectMutex.withLock(plan.files[0], async () => {
        await composeCommand(plan, ['config', '--quiet']);
        const originals = new Map<string, string>();
        const context = (container: Container) => ({
            triggerName: trigger.name,
            dockerApi: trigger.getWatcher(container)?.dockerApi,
            log: trigger.log,
        });
        const updates: Array<{
            service: string;
            current: string;
            update: string;
        }> = [];
        const effective = JSON.parse(
            await composeCommand(plan, ['config', '--format', 'json']),
        ) as {
            services: Record<string, { image?: string; profiles?: string[] }>;
        };
        if (
            Object.values(effective.services).some(
                (service) => service.profiles?.length,
            )
        )
            throw new Error(
                'Whole-stack updates do not support Compose profiles; use an explicitly reproducible project definition',
            );
        for (const container of containers.filter(
            (item) => item.updateAvailable,
        )) {
            const service = container.labels?.['com.docker.compose.service'];
            const current = service && effective.services[service]?.image;
            if (!service || !current)
                throw new Error('Cannot resolve the Compose service image');
            const mapping = trigger.mapCurrentVersionToUpdateVersion(
                { services: { [service]: { image: current } } },
                container,
                new Set(),
            );
            if (!mapping)
                throw new Error(
                    `Cannot resolve an updated image for service ${service}`,
                );
            if (mapping.update !== current)
                updates.push({ ...mapping, service });
        }
        // Rewrite only the last file that declares an image for each service;
        // Compose overrides therefore retain their original precedence.
        for (const file of plan.files)
            originals.set(file, await fs.readFile(file, 'utf8'));
        const yaml = await import('yaml');
        const updatesByFile = new Map<string, typeof updates>();
        for (const update of updates) {
            const file = [...plan.files].reverse().find((candidate) => {
                const doc = yaml.parse(originals.get(candidate)!) as {
                    services?: Record<string, { image?: string }>;
                };
                const image = doc?.services?.[update.service]?.image;
                if (typeof image === 'string' && image.includes('${'))
                    throw new Error(
                        'Interpolated Compose image declarations must be updated in their environment source',
                    );
                return typeof image === 'string';
            });
            if (!file)
                throw new Error(
                    `No writable image declaration for service ${update.service}`,
                );
            updatesByFile.set(file, [
                ...(updatesByFile.get(file) || []),
                update,
            ]);
        }
        const changed = new Set<string>();
        let deploymentCompleted = false;
        try {
            for (const container of containers) {
                await HookManager.runPreHooks(
                    container,
                    trigger.configuration.hooks,
                    context(container),
                );
                event.emitContainerUpdatePre(container);
            }
            for (const [file, changes] of updatesByFile) {
                if (trigger.configuration.backup)
                    await fs.copyFile(file, `${file}.wud-${Date.now()}.back`);
                const updated = trigger.updateComposeYaml(
                    originals.get(file)!,
                    changes,
                );
                const doc = yaml.parse(updated) as {
                    services?: Record<string, { image?: string }>;
                };
                for (const change of changes)
                    if (doc.services?.[change.service]?.image !== change.update)
                        throw new Error(
                            'Compose image rewrite could not be verified',
                        );
                changed.add(file);
                await fs.writeFile(file, updated);
            }
            await composeCommand(plan, ['config', '--quiet']);
            await composeCommand(plan, ['pull', '--ignore-buildable']);
            await composeCommand(plan, ['up', '--detach', '--no-build']);
            deploymentCompleted = true;
            for (const container of containers) {
                await HookManager.runPostHooks(
                    container,
                    trigger.configuration.hooks,
                    context(container),
                );
                event.emitContainerUpdateSuccess(container);
            }
        } catch (error) {
            // Restore declarations; deployment may have partially completed and
            // must be reported failed, never claimed rolled back.
            const restored = deploymentCompleted
                ? []
                : await Promise.allSettled(
                      [...changed].map((file) =>
                          fs.writeFile(file, originals.get(file)!),
                      ),
                  );
            if (restored.some((result) => result.status === 'rejected'))
                log.error(
                    'One or more Compose files could not be restored; manual recovery is required',
                );
            for (const container of containers) {
                try {
                    await HookManager.runFailureHooks(
                        container,
                        trigger.configuration.hooks,
                        context(container),
                    );
                } catch {
                    log.warn(`Failure hook failed for ${container.name}`);
                }
                event.emitContainerUpdateFailure(container);
            }
            if (restored.some((result) => result.status === 'rejected'))
                throw new Error(
                    'Compose update failed and file restoration failed; manual recovery is required',
                );
            throw error;
        }
    });
}
