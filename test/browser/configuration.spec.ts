import { expect, test } from '@playwright/test';

test('administrator can edit, test, save, reload, clear secrets, and sign out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveURL(/\/configure$/);
  await page.getByLabel('Administrator password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Connections tab: Prowlarr, qBittorrent, Metadata.
  await page.getByRole('tab', { name: 'Connections' }).click();
  await expect(page.getByRole('heading', { name: 'Make the connection.' })).toBeVisible();
  await page.locator('#prowlarr-url').fill('http://127.0.0.1:17071/prowlarr');
  await page.locator('#prowlarr-secret-action').selectOption('replace');
  await page.getByLabel('New API key', { exact: true }).fill('browser-test-key');
  await page.locator('#test-prowlarr').click();
  await expect(page.locator('#prowlarr-status')).toContainText('Connected successfully');
  // Testing the draft must not persist it.
  const beforeSave = await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()));
  expect(beforeSave.settings.prowlarr.url).toBe('');
  await page.locator('#qbittorrent-url').fill('http://127.0.0.1:17071/qbt');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.locator('#qbittorrent-secret-action').selectOption('replace');
  await page.getByLabel('New password', { exact: true }).fill('browser-qbt-password');
  await page.locator('#test-qbittorrent').click();
  await expect(page.locator('#qbittorrent-status')).toContainText('Connected successfully');
  await expect(page.locator('#save-state')).toContainText('unsaved changes');

  // Both tabs share one form: switching away and back keeps the unsaved edit.
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await page.getByRole('tab', { name: 'Connections' }).click();
  await expect(page.locator('#prowlarr-url')).toHaveValue('http://127.0.0.1:17071/prowlarr');
  await expect(page.locator('#save-state')).toContainText('unsaved changes');

  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await page.getByRole('tab', { name: 'Connections' }).click();
  await expect(page.locator('#prowlarr-url')).toHaveValue('http://127.0.0.1:17071/prowlarr');
  await expect(page.locator('#prowlarr-secret')).toHaveValue('');
  await expect(page.locator('#prowlarr-secret-action option:checked')).toHaveText('Keep saved credential');
  await page.locator('#test-prowlarr').click();
  await expect(page.locator('#prowlarr-status')).toContainText('Connected successfully');

  // Metadata: the TMDB key field only appears for the TMDB provider and persists.
  await expect(page.locator('#tmdb-fields')).toBeHidden();
  await page.locator('#metadata-provider').selectOption('tmdb');
  await expect(page.locator('#tmdb-fields')).toBeVisible();
  await page.locator('#metadata-secret-action').selectOption('replace');
  await page.getByLabel('New TMDB API key', { exact: true }).fill('browser-tmdb-key');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await page.getByRole('tab', { name: 'Connections' }).click();
  await expect(page.locator('#metadata-provider')).toHaveValue('tmdb');
  await expect(page.locator('#metadata-secret-action option:checked')).toHaveText('Keep saved key');

  await page.screenshot({ path: 'test-results/configuration-desktop-connections.png', fullPage: true });

  // Dashboard tab: just the install link and Downloads now.
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await expect(page.locator('#manifest-url')).toHaveValue(/^http:\/\/127\.0\.0\.1:17070\/addon\/[\w-]{43}\/manifest\.json$/);
  await expect(page.locator('#install-addon')).toHaveAttribute('href', /^stremio:\/\/127\.0\.0\.1:17070\/addon\/[\w-]{43}\/manifest\.json$/);

  const oldLink = await page.locator('#manifest-url').inputValue();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#rotate-addon').click();
  await expect(page.locator('#copy-status')).toContainText('Link replaced');
  const newLink = await page.locator('#manifest-url').inputValue();
  expect(newLink).not.toBe(oldLink);
  expect((await page.request.get(oldLink)).status()).toBe(404);
  expect((await page.request.get(newLink)).status()).toBe(200);

  // Library tab: Retention (a custom lease length shows its own field) and
  // Preferences (multiple resolutions/languages, not a single value).
  await page.getByRole('tab', { name: 'Library' }).click();
  await expect(page.locator('#retention-days-custom-field')).toBeHidden();
  await page.locator('#retention-days').selectOption('custom');
  await expect(page.locator('#retention-days-custom-field')).toBeVisible();
  await page.locator('#retention-days-custom').fill('45');
  await page.locator('#retention-target-ratio').fill('1.5');
  await page.locator('#retention-grace-days').fill('3');
  await page.locator('#retention-extend-on-play').uncheck();
  await page.locator('#retention-max-cache-gb').fill('250');
  await page.locator('input[name="pref-resolution"][value="2160"]').check();
  await page.locator('input[name="pref-resolution"][value="1080"]').check();
  await page.locator('input[name="pref-codec"][value="x265"]').check();
  await page.locator('input[name="pref-language"][value="en"]').check();
  await page.locator('input[name="pref-language"][value="fr"]').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await page.getByRole('tab', { name: 'Library' }).click();
  await expect(page.locator('#retention-days')).toHaveValue('custom');
  await expect(page.locator('#retention-days-custom')).toHaveValue('45');
  await expect(page.locator('#retention-target-ratio')).toHaveValue('1.5');
  await expect(page.locator('#retention-grace-days')).toHaveValue('3');
  await expect(page.locator('#retention-extend-on-play')).not.toBeChecked();
  await expect(page.locator('#retention-max-cache-gb')).toHaveValue('250');
  await expect(page.locator('input[name="pref-resolution"][value="2160"]')).toBeChecked();
  await expect(page.locator('input[name="pref-resolution"][value="1080"]')).toBeChecked();
  await expect(page.locator('input[name="pref-resolution"][value="720"]')).not.toBeChecked();
  await expect(page.locator('input[name="pref-codec"][value="x265"]')).toBeChecked();
  await expect(page.locator('input[name="pref-codec"][value="x264"]')).not.toBeChecked();
  await expect(page.locator('input[name="pref-language"][value="en"]')).toBeChecked();
  await expect(page.locator('input[name="pref-language"][value="fr"]')).toBeChecked();
  await expect(page.locator('input[name="pref-language"][value="de"]')).not.toBeChecked();

  await page.screenshot({ path: 'test-results/configuration-desktop-library.png', fullPage: true });

  // Dashboard tab: the seeded download renders, merges live qBittorrent status on refresh, and Keep persists.
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await expect(page.locator('.download-row')).toHaveCount(1);
  await expect(page.locator('.download-row')).toContainText('Test Movie (2020)');
  await page.locator('#downloads-refresh').click();
  await expect(page.locator('.download-row')).toContainText('ratio 1.50');
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
  await expect(page.locator('.download-meta')).toContainText('Kept');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();

  await page.screenshot({ path: 'test-results/configuration-desktop-dashboard.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/configuration-mobile-dashboard.png', fullPage: true });
  await page.getByRole('tab', { name: 'Library' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/configuration-mobile-library.png', fullPage: true });
  await page.getByRole('tab', { name: 'Connections' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/configuration-mobile-connections.png', fullPage: true });

  await page.locator('#prowlarr-secret-action').selectOption('clear');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await expect(page.locator('#prowlarr-secret-action option:checked')).toHaveText('Leave unset');

  // Delete removes the download after confirmation.
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#downloads-feedback')).toContainText('Deletion could not be confirmed');
  await expect(page.locator('.download-row')).toHaveCount(1);
  await page.locator('#downloads-refresh').click();
  await expect(page.locator('.download-row')).toContainText('deleting');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.download-row')).toHaveCount(0);
  await expect(page.locator('#downloads-list')).toContainText('No downloads yet.');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Administrator password')).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/admin/settings').then(r => r.status))).toBe(401);
  expect(errors).toEqual([]);
});
