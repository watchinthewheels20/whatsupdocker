---
title: Bulk updates and schedules
description: Manage selected container updates, persistent schedules, and whole Docker Compose stacks on Unraid.
---

# Bulk updates and schedules

Use **Containers** to select several containers and update them together. Use
**Schedules** to create recurring update checks that apply available updates to a
container or an entire Docker Compose project. A project with one service is
still a stack and uses the same workflow.

These features require a configured update trigger. Docker Compose deployments
should use a `dockercompose` trigger so image declarations stay in sync with the
running services. Read-only users can view schedules; write access is required
to change schedules or run updates.

## Select containers to update

1. Open **Containers** and select the containers to update.
2. Choose **Update selected** and select the update trigger and scope.
3. Review the selected targets before confirming.
4. Check each result; an individual failure does not mean the other targets
   failed. A dry-run trigger reports a skipped update without changing containers.
   Refresh the container list after the watcher reconciles the changes.

Container scope updates the selected services using the existing trigger.
Stack scope groups the selection by watcher and Compose project, and reconciles
each project once. It runs native `docker compose pull --ignore-buildable` and `docker compose up
--detach --no-build` for the project, including services you did not select. Compose decides
which containers need recreation. This is different from merely downloading an
image or replacing an individual container through the Docker Engine API. This
action does not build images, run `down`, or remove orphaned containers.

## Create and manage schedules

Create a schedule from a container’s **Schedule updates** action or the
**Schedules** page. Give it a name and choose the update trigger and target scope.
Choose a daily or weekly frequency, or enter a custom cron expression, with a
timezone. The default timezone is **Europe/London**; it follows local daylight
saving time rather than a fixed UTC offset.

For example, `0 4 * * 0` runs at 04:00 every Sunday in the selected timezone. Each
run checks the target for updates before applying any available update. A
container does not need an update available when you create its schedule.

The **Schedules** page lets you edit, pause or resume, run immediately, and delete
schedules, and inspect the next run and last result. **Run now** performs the
update action immediately, including for a paused schedule; it is not a preview. Pausing preserves the schedule
without running it automatically. Deleting a schedule does not remove containers.
Pausing or deleting a schedule does not cancel an update already in progress.

Schedules are saved in WUD's database. Mount `/store` persistently to retain them
when replacing the WUD container. Compose targets use watcher, project, and
service identity so replacing a container does not discard its schedule. If you
rename the watcher, project, or service, recreate or update the target. WUD must
be running for a schedule to fire; missed runs during downtime are not replayed.

### Keep automatic updates inside the chosen window

Set `WUD_TRIGGER_DOCKERCOMPOSE_LOCAL_AUTO=false` for a trigger named `local` when
you want only manual or scheduled updates. The scheduler explicitly invokes the
selected updater. If you leave automatic execution enabled, normal watcher scans
can also apply updates outside the schedule. Configure notification triggers
separately if you still want alerts between maintenance windows. Trigger
exclusions, snoozes, and update delays still apply; if a service in a native stack
is blocked by these policies, the stack operation fails before deployment.

## Deploy this build on Unraid

The features in this checkout require an image built from this checkout. An
upstream `getwud/wud` image does not contain your local changes.

After publishing the personal image to Docker Hub, use
`watchinthewheels20/wud-personal:personal` in the Compose example below and remove
`pull_policy: never`. Pull the image before redeploying WUD. The published
`sha-COMMIT` tag identifies the full source commit; pin the image digest from the
publishing workflow summary when you need a fixed image version.

For a local image without a registry, build on a Docker build machine from the
repository root:

```bash
docker build -t wud-personal:local .
docker save -o wud-personal.tar wud-personal:local
```

If the build machine is not your Unraid server, transfer `wud-personal.tar` to it
and import it with `docker load -i wud-personal.tar`. Build for the server's CPU
architecture. The Dockerfile includes the Docker CLI and Compose plugin needed
for native stack updates. You do not need to install Compose inside a running
WUD container.

Adapt this example to your actual stack directory and choose an available host
port. Here all managed projects live beneath `/mnt/user/appdata/stacks`, and WUD
has its own project outside that directory:

```yaml
services:
  whatsupdocker:
    image: wud-personal:local
    pull_policy: never
    container_name: wud
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      TZ: Europe/London
      WUD_AUTH_ADMIN_USER: ${WUD_AUTH_ADMIN_USER:?Set the admin user}
      WUD_AUTH_ADMIN_PASSWORD: ${WUD_AUTH_ADMIN_PASSWORD:?Set the admin password}
      WUD_TRIGGER_DOCKERCOMPOSE_LOCAL_AUTO: "false"
      WUD_TRIGGER_DOCKERCOMPOSE_LOCAL_BACKUP: "true"
      WUD_TRIGGER_DOCKERCOMPOSE_LOCAL_PATHMAPPING_HOST: /mnt/user/appdata/stacks
      WUD_TRIGGER_DOCKERCOMPOSE_LOCAL_PATHMAPPING_CONTAINER: /mnt/user/appdata/stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/user/appdata/wud/store:/store
      - /mnt/user/appdata/stacks:/mnt/user/appdata/stacks
```

Supply the admin variables through your Compose environment or a protected local
`.env` file. Keep credentials out of version control. Start WUD with your normal
Unraid Compose workflow, then sign in at `http://YOUR-UNRAID-HOST:3000`.

### Mount the complete project at the same absolute path

Native Compose reads the original project files from the running containers'
`com.docker.compose.project.config_files` labels. The path mapping above both
authorizes that directory and makes it accessible inside WUD. For a fixed single
project, an explicit `WUD_TRIGGER_DOCKERCOMPOSE_LOCAL_FILE` can authorize one
absolute primary Compose file instead; it must match the selected project’s
discovered primary file. WUD retains the ordered override files recorded in the
project labels. Native stack updates do not accept a templated `FILE` value.

Mount the directory at the **same absolute path on the host and inside WUD**.
Include all override files, `.env`, `env_file`, referenced secrets, and included
files. Compose resolves relative bind mounts using the project directory, but
the Docker daemon opens the resulting host paths. Mapping a host project to an
unrelated path such as `/stacks` can point relative binds at the wrong location.
Do not move existing Unraid projects just to match this example; use their actual
paths in both sides of the mount and both path-mapping variables. Compose uses the
project working directory recorded in its labels.

Make the project configuration reproducible from those files. WUD does not
reconstruct the shell environment or custom `--env-file` arguments used when
you first deployed a stack. Put the required values in the project’s `.env` or
another supported configuration file visible to WUD.

The mount must be writable because version changes update the Compose image
declarations. With `BACKUP=true`, native stack updates create unique
`.wud-TIMESTAMP.back` copies of modified files. Back up the projects and
application data before enabling unattended updates. Native stack updates reject
image declarations interpolated from variables such as `${APP_VERSION}` when
changing that declaration is required. Use an explicit image reference in the
Compose file, or continue managing that image version externally.

### Private images

Registry credentials configured in WUD allow update discovery, but native
`docker compose pull` uses the Docker CLI's own authentication. If your projects
use private images, prepare a dedicated Docker authentication file on the host
and mount it read-only at `/root/.docker/config.json` inside WUD. Alternatively,
mount a dedicated directory and set `DOCKER_CONFIG` to that directory. A config that
references a credential helper also requires that helper inside the image. Do
not mount the host's entire home directory or include credentials in your image.

### Runtime limits

- Native whole-stack updates require a local Docker socket watcher. A remote
  Docker host is not supported by this action.
- Native whole-stack updates reject projects using Compose profiles. WUD cannot
  reconstruct profile flags from the original deployment; use a project
  definition whose intended services are enabled without profiles.
- Access to the Docker socket permits administrative operations on the server.
  Limit WUD access to trusted users and networks, and mount only the project
  directories it should manage.
- Keep WUD in its own stack and update it externally. Native whole-stack updates
  reject the project containing WUD to avoid stopping the process performing
  the deployment. The existing dedicated self-update workflow is separate.
- All existing containers in a project must be visible to the watcher and eligible
  for its selected trigger. An unmonitored or excluded service blocks the stack
  action, so WUD cannot silently bypass that service’s update policies.
- Native reconciliation does not provide the existing updater's transactional
  health-check rollback. Targets with rollback enabled are rejected. Restoring
  Compose declarations after a failed command does not undo partially deployed
  containers or application migrations. Review failures before retrying.
- An update result means the command completed; application health still depends
  on the services' health checks and your monitoring. A stack operation may
  interrupt other services in the project.

Start with a manual update of a noncritical project. Confirm its Compose files,
volumes, and services remain correct before creating unattended schedules.

## API access

The same operations are available to authenticated API clients. Write requests
require write access and a JSON content type.

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/updates/options` | List updater triggers and stack availability |
| `POST /api/updates/run` | Run a bulk update with `containerIds`, `triggerId`, and `scope` |
| `GET /api/schedules` | List schedules, next runs, and last results |
| `POST /api/schedules` | Create a schedule using the current `containerId` as a stable target |
| `PUT` or `PATCH /api/schedules/{id}` | Edit a schedule or set `enabled` to pause or resume |
| `DELETE /api/schedules/{id}` | Remove a saved schedule |
| `POST /api/schedules/{id}/run` | Run the schedule immediately |

For schedule creation, supply `name`, `containerId`, `triggerId`, `scope`, and
`cron`; `timezone` defaults to `Europe/London` and `enabled` defaults to `true`.
Update scope is `container` or `stack`. A bulk response reports `updated`,
`skipped`, or `failed` per target. Inspect each result even when the HTTP request
succeeds.

## Release notes

Review the upstream release notes before upgrading applications with migration
requirements. Automatic changelog fetching and breaking-change classification
are not part of these update-management features; a missing warning does not
establish compatibility.
