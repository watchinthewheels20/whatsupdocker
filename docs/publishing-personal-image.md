# Publish the personal WUD image

The publishing workflow builds `linux/amd64` for an Unraid server and uploads
the tested image to the public Docker Hub repository
[`watchinthewheels20/wud-personal`](https://hub.docker.com/r/watchinthewheels20/wud-personal).
Create that repository with **Public** visibility in Docker Hub before the first
publication. The workflow does not create repositories or change their visibility.

## Connect Docker Hub securely

1. In Docker Hub account settings, create a personal access token with **Read &
   Write** permission. It needs permission to push to `watchinthewheels20/wud-personal`.
2. Open the repository's
   [GitHub Actions secrets settings](https://github.com/watchinthewheels20/whatsupdocker/settings/secrets/actions).
3. Add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `DOCKERHUB_USERNAME` | `watchinthewheels20` |
   | `DOCKERHUB_TOKEN` | The Docker Hub access token |

Enter the token directly into GitHub's secret form. Do not paste it into chat,
commit it, or add it to a Compose file. Docker Hub credentials are needed by the
publisher; pulling this public image on Unraid does not require the token.

## Build and publish

The workflow is `.github/workflows/publish-personal.yml`. A push to the dedicated
`feat/personal-dockerhub` branch runs it. Other branches, pull requests, upstream
release tags, and pushes to `main` do not publish this image.

The workflow can also run manually with `workflow_dispatch`, using a feature
branch containing the personal changes. GitHub generally requires a manually
dispatched workflow to exist on the default branch before it is discoverable;
the dedicated branch push provides the initial publication without merging
anything into `main`.

The workflow checks that the bulk update, scheduling, and stack update sources
are present and wired into the application. It runs backend and frontend lint,
unit tests, and production builds. It then builds the actual container and checks
the Docker Compose CLI, health endpoint, API authentication, schedule and update
APIs, and frontend JavaScript assets before logging in and uploading the image.
The smoke test does not mount a host Docker socket or update host containers.

Each successful publication produces:

- `watchinthewheels20/wud-personal:personal` by default, or the explicitly
  requested image tag when manually dispatched.
- `watchinthewheels20/wud-personal:sha-<full-source-commit>` to identify its source.
- A registry digest in the workflow summary, suitable for a permanently pinned
  deployment. Commit tags identify the source; Docker Hub tag immutability must
  be enabled separately if overwriting those tags must be prevented.

An unsuccessful validation or smoke test prevents publication. If credentials
were missing on the first push, add the secrets, then rerun the failed workflow
in GitHub Actions. There is no need to commit the credentials or merge the branch.

## Use it on Unraid

Once publication succeeds, change the WUD service's image. Preserve your existing
Compose service name; this example uses `whatsupdocker` as in the deployment guide:

```yaml
services:
  whatsupdocker:
    image: watchinthewheels20/wud-personal:personal
```

Remove `pull_policy: never` if it was used for a locally loaded development image.
Keep the existing persistent store, authentication configuration, Docker socket,
and Compose directory mounts. See the
[update management guide](../website/docs/configuration/update-management.md)
for the full Unraid Compose configuration and whole-stack mount requirements.

From that Compose project's directory, download and recreate only the WUD service:

```bash
docker compose pull whatsupdocker
docker compose up -d --no-deps whatsupdocker
```

For a reproducible deployment, replace the tag with the workflow summary's
`watchinthewheels20/wud-personal@sha256:...` reference. Back up WUD's persistent
store and the application data of managed stacks before testing updates on your
server.

To test a locally built image before publishing:

```bash
bash scripts/check-personal-source.sh
docker build --platform linux/amd64 -t wud-personal:local .
bash scripts/smoke-personal-image.sh wud-personal:local
```
