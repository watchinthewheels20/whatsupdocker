/*
 * Isolated native Docker Compose integration, without external registry images.
 * Run with npm run test:updates after npm ci in app/ and e2e/.
 * Requires a local Docker daemon, Compose v2, gcc with static libc, and tar.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, execFileSync, execFile } = require('child_process');
const { once } = require('events');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wud-updates-'));
const project = `wud-updates-${process.pid}`;
const composeFile = path.join(directory, 'compose.yaml');
const admin = 'integration_admin:IntegrationPassword123!';
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const digest = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let application;
let registry;
let port;
let image;
let activeVersion = '1';
const imageIds = new Set();
const report = (message) => process.stdout.write(`${message}\n`);

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function api(endpoint, method, body, credentials = admin, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (credentials) headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: method || 'GET', headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* Empty or plain-text response. */ }
    return { status: response.status, json, text };
}

async function waitUntil(check, timeout = 20000, deadline = Date.now() + timeout) {
    try { if (await check()) return; } catch { /* Service may still be starting. */ }
    if (Date.now() >= deadline) throw new Error(`Condition did not become true within ${timeout} ms; logs: ${directory}`);
    await delay(250);
    await waitUntil(check, timeout, deadline);
}

async function startApplication() {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('WUD_')));
    Object.assign(environment, {
        WUD_AUTH_ADMIN_USER: admin.split(':')[0],
        WUD_AUTH_ADMIN_PASSWORD: admin.split(':')[1],
        WUD_SERVER_PORT: String(port),
        WUD_STORE_PATH: path.join(directory, 'store'),
        WUD_WATCHER_LOCAL_WATCHBYDEFAULT: 'false',
        WUD_WATCHER_LOCAL_WATCHEVENTS: 'false',
        WUD_WATCHER_LOCAL_WATCHATSTART: 'false',
        WUD_WATCHER_LOCAL_CRON: '0 0 1 1 *',
        WUD_REGISTRY_CUSTOM_INTEGRATION_URL: `http://${image.split('/')[0]}`,
        WUD_TRIGGER_DOCKERCOMPOSE_INTEGRATION_AUTO: 'false',
        WUD_TRIGGER_DOCKERCOMPOSE_INTEGRATION_FILE: composeFile,
        WUD_TRIGGER_DOCKERCOMPOSE_INTEGRATION_BACKUP: 'false',
        WUD_TRIGGER_DOCKERCOMPOSE_INTEGRATION_PRUNE: 'false',
        TS_NODE_TRANSPILE_ONLY: 'true',
    });
    const log = fs.openSync(path.join(directory, 'app.log'), 'a');
    application = spawn(process.execPath, ['-r', 'ts-node/register', 'index.ts'], {
        cwd: path.join(root, 'app'), env: environment, stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    await waitUntil(async () => (await api('/api/schedules')).status === 200);
    const scanned = await api('/api/containers/watch', 'POST', {});
    assert.equal(scanned.status, 200, scanned.text);
    await waitUntil(async () => (await api('/api/containers')).json?.filter((container) => container.stack === project).length === 2);
}

async function stopApplication() {
    if (!application || application.exitCode !== null) return;
    const stopped = once(application, 'exit');
    application.kill('SIGTERM');
    const timeout = setTimeout(() => application.kill('SIGKILL'), 10000);
    await stopped;
    clearTimeout(timeout);
}

function inspectProject() {
    return JSON.parse(docker(['inspect', `${project}-alpha-1`, `${project}-beta-1`])).map((container) => {
        imageIds.add(container.Image);
        return { id: container.Id, image: container.Image, version: container.Config.Labels['qa.version'] };
    });
}

async function createRegistry() {
    const binary = path.join(directory, 'pause');
    const source = path.join(directory, 'pause.c');
    const tar = path.join(directory, 'layer.tar');
    fs.writeFileSync(source, '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n');
    execFileSync('gcc', ['-static', '-Os', '-s', '-o', binary, source]);
    execFileSync('tar', ['-C', directory, '-cf', tar, 'pause']);
    const layer = fs.readFileSync(tar);
    const compressed = zlib.gzipSync(layer);
    const blobs = new Map([[digest(compressed), compressed]]);
    const manifests = new Map();
    ['1', '2', '3', '4', '5'].forEach((version) => {
        const config = Buffer.from(JSON.stringify({
            architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
            os: 'linux',
            config: { Entrypoint: ['/pause'], Labels: { 'qa.version': version } },
            rootfs: { type: 'layers', diff_ids: [digest(layer)] },
            history: [{ created_by: 'wud-integration' }],
        }));
        blobs.set(digest(config), config);
        const manifest = Buffer.from(JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: digest(config) },
            layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: compressed.length, digest: digest(compressed) }],
        }));
        manifests.set(version, manifest);
        manifests.set(digest(manifest), manifest);
    });
    registry = http.createServer((request, response) => {
        response.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
        if (request.url === '/v2/' || request.url === '/v2') { response.end('{}'); return; }
        if (request.url.includes('/tags/list')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ name: 'fixture', tags: ['stable'] })); return; }
        const manifest = request.url.match(/^\/v2\/fixture\/manifests\/(.+)$/);
        const blob = request.url.match(/^\/v2\/fixture\/blobs\/(.+)$/);
        let data;
        if (manifest) data = manifests.get(manifest[1] === 'stable' ? activeVersion : manifest[1]);
        if (blob) data = blobs.get(blob[1]);
        if (!data) { response.writeHead(404); response.end('{}'); return; }
        response.setHeader('Content-Type', manifest ? 'application/vnd.docker.distribution.manifest.v2+json' : 'application/octet-stream');
        response.setHeader('Docker-Content-Digest', digest(data));
        response.setHeader('Content-Length', data.length);
        response.end(request.method === 'HEAD' ? undefined : data);
    });
    image = `127.0.0.1:${await listen(registry)}/fixture:stable`;
}

async function run() {
    docker(['compose', 'version']);
    await createRegistry();
    const portProbe = http.createServer();
    port = await listen(portProbe);
    await new Promise((resolve) => { portProbe.close(resolve); });
    fs.writeFileSync(composeFile, `services:\n${['alpha', 'beta'].map((name) => `  ${name}:\n    image: ${image}\n    labels:\n      wud.watch: 'true'\n      wud.watch.digest: 'true'\n      wud.tag.include: '^stable$$'\n`).join('')}`);
    await new Promise((resolve, reject) => {
        execFile('docker', ['compose', '--project-name', project, '--file', composeFile, 'up', '--detach'], (error) => {
            if (error) reject(error); else resolve();
        });
    });
    await startApplication();
    const containers = (await api('/api/containers')).json.filter((container) => container.stack === project);
    const ids = containers.map((container) => container.id);
    const update = { containerIds: ids, triggerId: 'dockercompose.integration', scope: 'stack' };
    assert.equal((await api('/api/schedules', 'GET', undefined, null)).status, 401);
    const reader = await api('/api/users', 'POST', { username: 'integration_reader', password: 'ReaderPassword123!', role: 'ro' });
    assert.equal(reader.status, 201, reader.text);
    assert.equal((await api('/api/schedules', 'GET', undefined, 'integration_reader:ReaderPassword123!')).status, 200);
    assert.equal((await api('/api/updates/run', 'POST', update, 'integration_reader:ReaderPassword123!')).status, 403);
    assert.equal((await api('/api/schedules', 'POST', {}, 'integration_reader:ReaderPassword123!')).status, 403);
    assert.equal((await api('/api/updates/run', 'POST', update, admin, { Origin: 'https://external.invalid' })).status, 403);
    assert.equal((await api('/api/updates/run', 'POST', { ...update, containerIds: [ids[0], ids[0]] })).status, 400);
    const noOp = await api('/api/updates/run', 'POST', update);
    assert(noOp.json.results.every((result) => result.status === 'skipped'), noOp.text);
    const input = {
        name: 'Integration schedule', containerId: ids[0], triggerId: update.triggerId, scope: 'stack', cron: '0 3 * * *', timezone: 'Europe/London', enabled: false,
    };
    assert.equal((await api('/api/schedules', 'POST', { ...input, timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await api('/api/schedules', 'POST', { ...input, cron: '* * * * * *' })).status, 400);
    const created = await api('/api/schedules', 'POST', input);
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.nextRunAt, null);
    const scheduleId = created.json.id;
    report('PASS authentication, read-only permissions, origin checks, schema, CRUD and no-op bulk');
    const before = inspectProject();
    assert(before.every((container) => container.version === '1'));
    activeVersion = '2';
    const native = await api('/api/updates/run', 'POST', { ...update, containerIds: [ids[0]] });
    assert.equal(native.json.results[0].status, 'updated', native.text);
    const after = inspectProject();
    assert(after.every((container, index) => container.version === '2' && container.id !== before[index].id));
    report('PASS selecting one service natively pulls and reconciles both Compose services');
    const resolved = await api(`/api/schedules/${scheduleId}/run`, 'POST', {});
    assert.equal(resolved.status, 200, resolved.text);
    assert(resolved.json.results.every((result) => result.status === 'skipped'), resolved.text);
    await stopApplication();
    await startApplication();
    const persisted = (await api('/api/schedules')).json.find((schedule) => schedule.id === scheduleId);
    assert.equal(persisted.timezone, 'Europe/London');
    assert.equal(persisted.lastStatus, 'skipped');
    assert.equal(persisted.enabled, false);
    activeVersion = '3';
    const current = (await api('/api/containers')).json.find((container) => container.labels?.['com.docker.compose.project'] === project && container.labels?.['com.docker.compose.service'] === 'alpha');
    const containerSchedule = await api('/api/schedules', 'POST', {
        ...input, name: 'Single service', containerId: current.id, scope: 'container', cron: '* * * * *', enabled: true,
    });
    assert.equal(containerSchedule.status, 201, containerSchedule.text);
    const containerScheduleId = containerSchedule.json.id;
    report(`Waiting for container cron execution at ${containerSchedule.json.nextRunAt}`);
    await waitUntil(async () => (await api('/api/schedules')).json.find((schedule) => schedule.id === containerScheduleId)?.lastStatus === 'updated', 75000);
    const singleService = inspectProject();
    assert.equal(singleService[0].version, '3');
    assert.equal(singleService[1].version, '2');
    assert.equal((await api(`/api/schedules/${containerScheduleId}`, 'PUT', { enabled: false })).json.nextRunAt, null);
    report('PASS actual container cron updates its service while its Compose sibling stays at the previous version');
    activeVersion = '4';
    const enabled = await api(`/api/schedules/${scheduleId}`, 'PATCH', { cron: '* * * * *', enabled: true });
    assert.equal(enabled.status, 200, enabled.text);
    assert(enabled.json.nextRunAt);
    report(`Waiting for actual cron execution at ${enabled.json.nextRunAt}`);
    await waitUntil(async () => (await api('/api/schedules')).json.find((schedule) => schedule.id === scheduleId)?.lastStatus === 'updated', 75000);
    assert(inspectProject().every((container) => container.version === '4'));
    assert.equal((await api(`/api/schedules/${scheduleId}`, 'PUT', { enabled: false })).json.nextRunAt, null);
    assert.equal((await api(`/api/schedules/${scheduleId}`, 'DELETE')).status, 204);
    assert.equal((await api(`/api/schedules/${scheduleId}/run`, 'POST', {})).status, 404);
    assert.equal((await api(`/api/schedules/${containerScheduleId}`, 'DELETE')).status, 204);
    report('PASS restart persistence, stable targets after recreation, actual stack cron check-and-apply, pause and deletion');
    activeVersion = '5';
    assert.equal((await api('/api/containers/watch', 'POST', {})).status, 200);
    const latestIds = (await api('/api/containers')).json.filter((container) => container.labels?.['com.docker.compose.project'] === project).map((container) => container.id);
    const bulk = await api('/api/updates/run', 'POST', { ...update, containerIds: latestIds, scope: 'container' });
    assert.equal(bulk.json.results.length, 2, bulk.text);
    assert(bulk.json.results.every((result) => result.status === 'updated'), bulk.text);
    assert(inspectProject().every((container) => container.version === '5'));
    report('PASS real bulk update applies both selected container updates with individual results');
}

run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }).finally(async () => {
    await stopApplication();
    try { docker(['compose', '--project-name', project, '--file', composeFile, 'down', '--volumes']); } catch { /* Setup may have failed before Compose started. */ }
    if (image) { try { docker(['image', 'rm', '--force', image, ...imageIds]); } catch { /* Leave diagnostics on cleanup failure. */ } }
    if (registry) await new Promise((resolve) => { registry.close(resolve); });
    report(`Integration logs: ${directory}`);
});
