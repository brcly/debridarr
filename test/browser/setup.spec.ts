import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, port: number) {
  await page.goto(`http://127.0.0.1:${port}/configure`);
  await page.getByLabel('Administrator password', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up Debridarr', exact: true })).toBeVisible();
}
async function next(page: Page) {
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
}
async function connectQbt(page: Page) {
  await page.getByLabel('qBittorrent Web UI address').fill('http://127.0.0.1:17071/qbt');
  await page.getByLabel('qBittorrent username', { exact: true }).fill('admin');
  await page.getByLabel('qBittorrent password', { exact: true }).fill('browser-qbt-password');
  await next(page);
}

async function cachePolicy(page: Page) {
  await expect(page.getByRole('heading', { name: 'Choose your cache policy' })).toBeVisible();
  await page.getByLabel('Maximum extra seeding days after expiry').fill('7');
  await next(page);
}

test('fresh Store setup tests credentials, saves progress, skips discovery, and stays complete after reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, 17072);
  await expect(page.locator('#workspace')).toBeHidden();
  await page.locator('input[name="setup-mode"][value="store"]').check();
  await expect(page.locator('#setup-progress li')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/setup-desktop-mode.png', fullPage: true });
  await next(page);
  await expect(page.getByRole('heading', { name: 'Connect qBittorrent', exact: true })).toBeVisible();
  await page.getByLabel('Download client').selectOption('deluge');
  await expect(page.getByRole('heading', { name: 'Connect Deluge', exact: true })).toBeVisible();
  await expect(page.locator('#setup-backend-username-field')).toBeHidden();
  await page.getByLabel('Download client').selectOption('sabnzbd');
  await expect(page.getByRole('heading', { name: 'Connect SABnzbd', exact: true })).toBeVisible();
  await expect(page.locator('#setup-backend-username-field')).toBeHidden();
  await expect(page.locator('#setup-backend-password-label')).toContainText('api key');
  await page.getByLabel('Download client').selectOption('qbittorrent');
  await expect(page.getByRole('heading', { name: 'Connect qBittorrent', exact: true })).toBeVisible();
  await next(page);
  await expect(page.getByRole('heading', { name: 'Connect qBittorrent', exact: true })).toBeVisible();
  await page.getByLabel('qBittorrent Web UI address').fill('http://127.0.0.1:17071/qbt');
  await page.getByLabel('qBittorrent username', { exact: true }).fill('admin');
  await page.getByLabel('qBittorrent password', { exact: true }).fill('wrong-password');
  await next(page);
  await expect(page.locator('#setup-feedback')).toHaveClass(/error/);
  const before = await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()));
  expect(before.settings.downloadBackend.url).toBe('');
  await connectQbt(page);
  await cachePolicy(page);
  await expect(page.getByRole('heading', { name: 'Ready for your first download' })).toBeVisible();
  await expect(page.locator('#setup-summary')).toContainText('Not needed in Store mode');
  await expect(page.locator('#setup-summary')).toContainText('Store APIs are on');
  await expect(page.locator('#setup-summary')).toContainText('Open administration at http://127.0.0.1:17072/configure');
  await expect(page.locator('#setup-download-dir')).toContainText('/downloads');
  await expect(page.locator('#setup-downloadBackend-password')).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/setup-mobile-review.png', fullPage: true });
  // Incomplete setup retains connections and appears again on reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set up Debridarr', exact: true })).toBeVisible();
  await expect(page.locator('input[name="setup-mode"][value="store"]')).toBeChecked();
  await next(page);
  await expect(page.getByLabel('qBittorrent Web UI address')).toHaveValue('http://127.0.0.1:17071/qbt');
  await expect(page.locator('#setup-backend-password-help')).toContainText('A password is saved');
  await next(page); // Reuses the saved credential, which is never sent to the browser.
  await cachePolicy(page);
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.locator('#setup-panel')).toBeHidden();
  await expect(page.locator('#page-title')).toBeVisible();
  await page.reload();
  await expect(page.locator('#setup-panel')).toBeHidden();
  expect((await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()))).settings.setup.completed).toBe(true);
  await page.getByRole('button', { name: 'Setup guide', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up Debridarr', exact: true })).toBeVisible();
  await page.locator('input[name="setup-mode"][value="both"]').check();
  await next(page);
  await next(page); // Reuse the saved qBittorrent connection.
  await expect(page.getByRole('heading', { name: 'Connect discovery providers' })).toBeVisible();
  await page.locator('#setup-skip-discovery').click();
  await cachePolicy(page);
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  expect(errors).toEqual([]);
});

test('fresh Search setup guides discovery providers, supports leaving early, and tests before saving', async ({ page }) => {
  await login(page, 17073);
  await page.getByRole('button', { name: 'Go to dashboard', exact: true }).click();
  await expect(page.locator('#page-title')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set up Debridarr', exact: true })).toBeVisible();
  await expect(page.locator('#setup-progress li')).toHaveCount(5);
  await next(page);
  await connectQbt(page);
  await expect(page.getByRole('heading', { name: 'Connect discovery providers', exact: true })).toBeVisible();
  await expect(page.locator('#setup-skip-discovery')).toBeVisible();
  await page.locator('#setup-add-discovery-provider').click();
  const provider = page.locator('#setup-discovery-provider-list .discovery-provider').first();
  await expect(provider.getByLabel('Provider type')).toHaveValue('prowlarr');
  await provider.getByLabel('Address').fill('http://127.0.0.1:17071/prowlarr');
  await provider.getByLabel('API key', { exact: true }).selectOption('replace');
  await provider.getByLabel('New api key').fill('browser-test-key');
  await provider.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(provider.getByRole('status')).toContainText('Connected successfully');
  expect((await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()))).settings.discovery.providers).toEqual([]);
  // Content preferences are scoped to the provider row.
  await provider.locator('input[name$="-pref-resolution"][value="1080"]').check();
  await provider.locator('input[name$="-pref-codec"][value="x265"]').check();
  await provider.locator('input[name$="-pref-language"][value="en"]').check();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/setup-mobile-preferences.png', fullPage: true });
  await next(page);
  const savedProviders = (await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()))).settings.discovery.providers;
  expect(savedProviders).toHaveLength(1);
  expect(savedProviders[0].preferences).toEqual({ resolutions: [1080], codecs: ['x265'], languages: ['en'] });
  await cachePolicy(page);
  await page.locator('#setup-check-playback').click();
  await expect(page.locator('#setup-checks')).toContainText('Not verified yet');
  await expect(page.locator('#setup-checks')).toContainText('100.0 GB free');
  await expect(page.locator('#setup-summary')).toContainText('http://127.0.0.1:17071/prowlarr');
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  expect((await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()))).settings.setup.completed).toBe(true);
});
