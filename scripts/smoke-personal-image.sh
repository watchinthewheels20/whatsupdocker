#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: smoke-personal-image.sh IMAGE}"
container_name="wud-personal-smoke-${RANDOM}-${RANDOM}"
export WUD_AUTH_ADMIN_USER=smoke-admin
WUD_AUTH_ADMIN_PASSWORD="$(openssl rand -hex 24)"
export WUD_AUTH_ADMIN_PASSWORD

cleanup() {
  docker rm --force --volumes "$container_name" >/dev/null 2>&1 || true
  unset WUD_AUTH_ADMIN_PASSWORD
}
trap cleanup EXIT

# No host Docker socket or published port: this validates the image without
# giving the smoke test access to the host's containers.
docker run --detach --name "$container_name" \
  --env WUD_AUTH_ADMIN_USER --env WUD_AUTH_ADMIN_PASSWORD \
  --env WUD_LOG_FORMAT=json --env TZ=Europe/London \
  --env WUD_WATCHER_DOCKER_LOCAL_WATCHBYDEFAULT=false \
  --env WUD_WATCHER_DOCKER_LOCAL_WATCHATSTART=false \
  --env WUD_WATCHER_DOCKER_LOCAL_WATCHEVENTS=false \
  "$image" >/dev/null

docker exec "$container_name" docker --version
docker exec "$container_name" docker compose version
docker exec -i "$container_name" node <<'NODE'
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3000';
const authorization = 'Basic ' + Buffer.from(
  `${process.env.WUD_AUTH_ADMIN_USER}:${process.env.WUD_AUTH_ADMIN_PASSWORD}`,
).toString('base64');

async function request(path, authenticated = false) {
  return fetch(new URL(path, origin), {
    headers: authenticated ? { authorization } : {},
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });
}

(async () => {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      if ((await request('/health')).ok) { ready = true; break; }
    } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Application health endpoint did not become ready');
  for (const path of ['/api/schedules', '/api/updates/options']) {
    assert.equal((await request(path)).status, 401, `${path} must require authentication`);
    const response = await request(path, true);
    assert.equal(response.status, 200, `${path} must be available to the administrator`);
    const data = await response.json();
    if (path.endsWith('/options')) {
      assert.ok(Array.isArray(data.triggers), 'Update options must include triggers');
      assert.ok(Array.isArray(data.stacks), 'Update options must include stacks');
    } else {
      assert.ok(Array.isArray(data), 'Schedules must be a JSON array');
    }
  }
  const home = await request('/');
  assert.equal(home.status, 200, 'UI must be served');
  const html = await home.text();
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(scripts.length > 0, 'UI must reference its compiled JavaScript');
  for (const source of scripts) {
    const asset = await request(source);
    assert.equal(asset.status, 200, `UI asset missing: ${source}`);
    assert.match(asset.headers.get('content-type') || '', /javascript/);
  }
  console.log('Image smoke checks passed: Compose CLI, health, authenticated APIs, and UI assets.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
