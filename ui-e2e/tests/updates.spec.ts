import { test, expect, Page } from '@playwright/test';

// These browser tests isolate the management workflow from registries and Docker.
// Native Compose execution is covered separately against a disposable project.
async function mockUpdates(page: Page, role = 'admin', stackAvailable = true) {
  const containers = ['alpha', 'beta'].map((name) => ({
    id: name, name, displayName: name, watcher: 'local', stack: 'media',
    updateAvailable: false, labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': name },
    image: { name: `qa/${name}`, registry: { name: 'custom.qa', url: 'registry.invalid' }, tag: { value: 'stable', semver: false }, digest: { watch: true, value: 'sha256:old' } },
    result: { tag: 'stable', digest: 'sha256:old' },
  }));
  const writes: { path: string; method: string; body: any }[] = [];
  let schedules: any[] = [];
  await page.route('**/auth/user', (route) => route.fulfill({ json: { username: 'qa', role } }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (path === '/api/server') return route.fulfill({ json: { configuration: { feature: { delete: true } } } });
    if (path === '/api/containers') return route.fulfill({ json: containers });
    if (path === '/api/updates/options') return route.fulfill({ json: {
      triggers: [{ id: 'dockercompose.qa', type: 'dockercompose', name: 'qa', dryrun: false }],
      stacks: [{ id: 'local:media', name: 'media', watcher: 'local', containerIds: ['alpha', 'beta'], composeFiles: ['/stacks/media/compose.yaml'], available: stackAvailable, reason: stackAvailable ? undefined : 'Compose path is not authorized' }],
    } });
    if (path === '/api/updates/run' || path.endsWith('/run')) {
      return route.fulfill({ json: { results: [{ id: 'alpha', name: 'alpha', status: 'updated' }, { id: 'beta', name: 'beta', status: 'failed', message: 'Registry unavailable' }] } });
    }
    if (path === '/api/schedules') {
      if (method === 'POST') {
        const schedule = { ...body, id: 'schedule-1', target: { watcher: 'local', name: body.containerId, composeProject: 'media', composeService: body.containerId }, nextRunAt: '2026-10-19T02:00:00Z' };
        schedules.push(schedule);
        return route.fulfill({ status: 201, json: schedule });
      }
      return route.fulfill({ json: schedules });
    }
    if (path === '/api/schedules/schedule-1') {
      if (method === 'DELETE') { schedules = []; return route.fulfill({ status: 204 }); }
      schedules[0] = { ...schedules[0], ...body };
      return route.fulfill({ json: schedules[0] });
    }
    return route.fulfill({ json: [] });
  });
  return writes;
}

test('bulk selection confirms whole-stack scope and shows per-target results', async ({ page }) => {
  const writes = await mockUpdates(page);
  await page.goto('/containers');
  await page.getByRole('button', { name: 'Select filtered', exact: true }).click();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update selected', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Entire Compose stacks', { exact: true }).check();
  await expect(dialog.getByText(/including services outside your selection/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('media (local)', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Update stacks', exact: true }).click();
  await expect(dialog.getByText('alpha: updated', { exact: true })).toBeVisible();
  await expect(dialog.getByText('beta: failed', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Registry unavailable', { exact: true })).toBeVisible();
  expect(writes.find((write) => write.path === '/api/updates/run')?.body).toEqual({ containerIds: ['alpha', 'beta'], triggerId: 'dockercompose.qa', scope: 'stack' });
});

test('an unauthorized Compose path disables whole-stack selection', async ({ page }) => {
  await mockUpdates(page, 'admin', false);
  await page.goto('/containers');
  await page.getByRole('button', { name: 'Select filtered', exact: true }).click();
  await page.getByRole('button', { name: 'Update selected', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Entire Compose stacks', { exact: true })).toBeDisabled();
  await expect(dialog.getByText(/Compose path is not authorized/)).toBeVisible();
});

test('schedules use London time and support edit, pause, run and confirmed deletion', async ({ page }) => {
  const writes = await mockUpdates(page);
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Schedule name', { exact: true }).fill('Nightly media');
  await expect(dialog.getByLabel('Timezone', { exact: true })).toHaveValue('Europe/London');
  await dialog.getByLabel('Container', { exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: 'alpha (local)', exact: true }).click();
  await dialog.getByLabel('Update scope', { exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: 'Entire Compose stack', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(page.getByText('Nightly media', { exact: true })).toBeVisible();
  expect(writes.find((write) => write.method === 'POST' && write.path === '/api/schedules')?.body).toEqual({ name: 'Nightly media', containerId: 'alpha', scope: 'stack', triggerId: 'dockercompose.qa', cron: '0 3 * * *', timezone: 'Europe/London', enabled: true });

  await page.getByLabel('Edit Nightly media', { exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Schedule name', { exact: true }).fill('Weekly media');
  await dialog.getByLabel('Cron expression', { exact: true }).fill('0 3 * * 0');
  await dialog.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await page.getByLabel('Pause Weekly media', { exact: true }).uncheck();
  await expect(page.getByRole('cell', { name: /^Paused/ })).toBeVisible();
  await page.getByLabel('Enable Weekly media', { exact: true }).check();
  await expect(page.getByRole('cell', { name: /^Paused/ })).toHaveCount(0);
  await page.getByLabel('Run Weekly media now', { exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/Every service in this Compose stack is included/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('beta: failed', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Delete Weekly media', { exact: true }).click();
  expect(writes.filter((write) => write.method === 'DELETE')).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No update schedules yet.', { exact: false })).toBeVisible();
  expect(writes.filter((write) => write.method === 'DELETE')).toHaveLength(1);
});

test('read-only users can view schedules without update or schedule mutation controls', async ({ page }) => {
  const writes = await mockUpdates(page, 'ro');
  await page.goto('/containers');
  await expect(page.getByText('alpha', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update selected', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select filtered', exact: true })).toHaveCount(0);
  await page.goto('/schedules');
  await expect(page.getByRole('heading', { name: 'Update schedules', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create schedule', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});
