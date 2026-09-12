import { expect, test, type Page } from '@playwright/test';

async function openSettings(page: Page, tab: 'Connections' | 'Library' | 'Access' = 'Connections') {
  await page.getByRole('button', { name: '⚙ Settings' }).click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-dialog').getByRole('tab', { name: tab, exact: true }).click();
}

test('administrator can edit, test, save, reload, clear secrets, and sign out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveURL(/\/configure$/);
  expect((await page.request.get('/configure')).headers()['content-security-policy'] ?? '').toContain("default-src 'none'");
  expect((await page.request.get('/health')).headers()['content-security-policy']).toBeFalsy();
  await page.getByLabel('Administrator password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#page-title')).toBeVisible();

  // Settings dialog, Connections tab: Discovery providers, download client, Metadata.
  await openSettings(page);

  // The dialog must stay inside the viewport with a scrollable body and a
  // pinned footer, so the sections below the fold stay user-reachable.
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('#settings-dialog') as HTMLElement;
    const body = dialog.querySelector('.dialog-body') as HTMLElement;
    const footer = dialog.querySelector('.dialog-footer') as HTMLElement;
    const box = dialog.getBoundingClientRect();
    return {
      withinViewport: box.top >= -1 && box.bottom <= window.innerHeight + 1,
      bodyOverflow: getComputedStyle(body).overflowY,
      bodyScrollable: body.scrollHeight > body.clientHeight,
      footerInside: footer.getBoundingClientRect().bottom <= box.bottom + 1,
    };
  });
  expect(geometry.withinViewport).toBe(true);
  expect(geometry.bodyOverflow).toBe('auto');
  expect(geometry.bodyScrollable).toBe(true);
  expect(geometry.footerInside).toBe(true);

  // The download client sits below the fold: scrolling the dialog body has to
  // bring it out from under the dialog's clipping, and it has to take input.
  await expect(page.locator('#downloadBackend-url')).not.toBeInViewport();
  await page.locator('#downloadBackend-url').scrollIntoViewIfNeeded();
  await expect(page.locator('#downloadBackend-url')).toBeInViewport();
  expect(await page.locator('#downloadBackend-url').evaluate(element => {
    const body = (element.closest('.dialog-body') as HTMLElement).getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return box.top >= body.top - 1 && box.bottom <= body.bottom + 1 && box.height > 0;
  })).toBe(true);

  await expect(page.locator('#mode-surfaces')).toContainText('stay off until you switch to Store or Both');
  await page.locator('#operating-mode').selectOption('both');
  await expect(page.locator('#mode-surfaces')).toContainText('API tokens, /api/v1, Comet, AIOStreams, and Real-Debrid routes are on');
  await expect(page.locator('#downloadBackend-type')).toContainText('Deluge');
  await expect(page.locator('#downloadBackend-type')).toContainText('SABnzbd');
  await page.locator('#downloadBackend-type').selectOption('sabnzbd');
  await expect(page.locator('#backend-protocol-note')).toBeVisible();
  await expect(page.locator('#backend-protocol-note')).toContainText('NZBs');
  await page.locator('#downloadBackend-type').selectOption('qbittorrent');
  await expect(page.locator('#backend-protocol-note')).toBeHidden();

  // Discovery providers are descriptor-driven rows and test without saving.
  await page.locator('#add-discovery-provider').click();
  const provider = page.locator('.discovery-provider').first();
  await expect(provider.getByLabel('Provider type')).toHaveValue('prowlarr');
  await provider.getByLabel('Address').fill('http://127.0.0.1:17071/prowlarr');
  await provider.getByLabel('API key', { exact: true }).selectOption('replace');
  await provider.getByLabel('New api key').fill('browser-test-key');
  await provider.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(provider.getByRole('status')).toContainText('Connected successfully');
  // Each provider row carries its own content preferences.
  await provider.locator('input[name$="-pref-resolution"][value="2160"]').check();
  await provider.locator('input[name$="-pref-resolution"][value="1080"]').check();
  await provider.locator('input[name$="-pref-codec"][value="x265"]').check();
  await provider.locator('input[name$="-pref-language"][value="en"]').check();
  await provider.locator('input[name$="-pref-language"][value="fr"]').check();
  // Testing the draft must not persist it.
  const beforeSave = await page.evaluate(() => fetch('/api/admin/settings').then(r => r.json()));
  expect(beforeSave.settings.discovery.providers).toEqual([]);
  await page.locator('#downloadBackend-url').fill('http://127.0.0.1:17071/qbt');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.locator('#downloadBackend-path-mappings').fill('/remote/downloads => /downloads');
  await page.locator('#downloadBackend-secret-action').selectOption('replace');
  await page.getByLabel('New password', { exact: true }).fill('browser-qbt-password');
  await page.locator('#test-downloadBackend').click();
  await expect(page.locator('#downloadBackend-status')).toContainText('Connected successfully');
  await expect(page.locator('#save-state')).toContainText('unsaved changes');

  // Both tabs share one form: switching away and back keeps the unsaved edit.
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Library', exact: true }).click();
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.discovery-provider').first().getByLabel('Address')).toHaveValue('http://127.0.0.1:17071/prowlarr');
  await expect(page.locator('#downloadBackend-path-mappings')).toHaveValue('/remote/downloads => /downloads');
  await expect(page.locator('#save-state')).toContainText('unsaved changes');

  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await openSettings(page);
  const savedProvider = page.locator('.discovery-provider').first();
  await expect(savedProvider.getByLabel('Provider type')).toHaveValue('prowlarr');
  await expect(savedProvider.getByLabel('Address')).toHaveValue('http://127.0.0.1:17071/prowlarr');
  await expect(savedProvider.getByLabel('API key', { exact: true }).locator('option:checked')).toHaveText('Keep saved key');
  await expect(savedProvider.getByLabel('New api key')).toHaveValue('');
  await expect(savedProvider.locator('input[name$="-pref-resolution"][value="2160"]')).toBeChecked();
  await expect(savedProvider.locator('input[name$="-pref-resolution"][value="1080"]')).toBeChecked();
  await expect(savedProvider.locator('input[name$="-pref-resolution"][value="720"]')).not.toBeChecked();
  await expect(savedProvider.locator('input[name$="-pref-codec"][value="x265"]')).toBeChecked();
  await expect(savedProvider.locator('input[name$="-pref-language"][value="en"]')).toBeChecked();
  await expect(savedProvider.locator('input[name$="-pref-language"][value="fr"]')).toBeChecked();
  await expect(savedProvider.locator('input[name$="-pref-language"][value="de"]')).not.toBeChecked();
  await savedProvider.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(savedProvider.getByRole('status')).toContainText('Connected successfully');

  // Clear is explicit and add/remove does not disturb the saved row.
  await savedProvider.getByLabel('API key', { exact: true }).selectOption('clear');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(savedProvider.getByLabel('API key', { exact: true }).locator('option:checked')).toHaveText('Leave unset');
  await savedProvider.getByLabel('API key', { exact: true }).selectOption('replace');
  await savedProvider.getByLabel('New api key').fill('browser-test-key');
  await page.locator('#add-discovery-provider').click();
  await expect(page.locator('.discovery-provider')).toHaveCount(2);
  await page.locator('.discovery-provider').nth(1).getByRole('button', { name: 'Remove provider' }).click();
  await expect(page.locator('.discovery-provider')).toHaveCount(1);

  // Metadata: the TMDB key field only appears for the TMDB provider and persists.
  await expect(page.locator('#tmdb-fields')).toBeHidden();
  await page.locator('#metadata-provider').selectOption('tmdb');
  await expect(page.locator('#tmdb-fields')).toBeVisible();
  await page.locator('#metadata-secret-action').selectOption('replace');
  await page.getByLabel('New TMDB API key', { exact: true }).fill('browser-tmdb-key');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('#metadata-provider')).toHaveValue('tmdb');
  await expect(page.locator('#metadata-secret-action option:checked')).toHaveText('Keep saved key');

  // Saved searches: hidden until Store/Both (already on from earlier in this
  // test), add/fill/save/reload persists, and poll now round-trips through
  // the real admin route even when the feed itself is unreachable.
  await expect(page.locator('#rss-card')).toBeVisible();
  await page.locator('#add-saved-search').click();
  const search = page.locator('.saved-search').first();
  await search.getByLabel('Feed URL').fill('http://127.0.0.1:1/rss');
  await search.getByLabel('Protocol').selectOption('torrent');
  await search.getByLabel('Title must include').fill('1080p');
  await search.getByLabel('Title must not include').fill('CAM');
  await search.getByLabel('Queue instead of rejecting when at the active download cap').check();
  await expect(search.getByRole('button', { name: 'Poll now' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await openSettings(page);
  const savedSearch = page.locator('.saved-search').first();
  await expect(savedSearch.getByLabel('Feed URL')).toHaveValue('http://127.0.0.1:1/rss');
  await expect(savedSearch.getByLabel('Title must include')).toHaveValue('1080p');
  await expect(savedSearch.getByLabel('Queue instead of rejecting when at the active download cap')).toBeChecked();
  await expect(savedSearch.getByRole('button', { name: 'Poll now' })).toBeEnabled();
  await savedSearch.getByRole('button', { name: 'Poll now' }).click();
  await expect(savedSearch.getByRole('status')).toContainText('Last poll');
  await savedSearch.getByRole('button', { name: 'Remove search' }).click();
  await expect(page.locator('.saved-search')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('.saved-search')).toHaveCount(0);

  await page.screenshot({ path: 'test-results/configuration-desktop-connections.png' });

  // Access tab: the install link and its rotation.
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Access', exact: true }).click();
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
  // the playback opt-in. Content preferences now live per provider row.
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Library', exact: true }).click();
  await expect(page.locator('#retention-days-custom-field')).toBeHidden();
  await page.locator('#retention-days').selectOption('custom');
  await expect(page.locator('#retention-days-custom-field')).toBeVisible();
  await page.locator('#retention-days-custom').fill('45');
  await page.locator('#retention-target-ratio').fill('1.5');
  await page.locator('#retention-grace-days').fill('3');
  await page.locator('#retention-extend-on-play').uncheck();
  await page.locator('#retention-max-cache-gb').fill('250');
  await expect(page.getByText('Experimental:', { exact: false })).toBeVisible();
  await page.locator('#playback-stream-while-downloading').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.reload();
  await openSettings(page, 'Library');
  await expect(page.locator('#retention-days')).toHaveValue('custom');
  await expect(page.locator('#retention-days-custom')).toHaveValue('45');
  await expect(page.locator('#retention-target-ratio')).toHaveValue('1.5');
  await expect(page.locator('#retention-grace-days')).toHaveValue('3');
  await expect(page.locator('#retention-extend-on-play')).not.toBeChecked();
  await expect(page.locator('#retention-max-cache-gb')).toHaveValue('250');
  await expect(page.locator('#playback-stream-while-downloading')).toBeChecked();

  await page.screenshot({ path: 'test-results/configuration-desktop-library.png' });

  // Closing the dialog returns to the Downloads page, which keeps polling.
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.locator('.download-row')).toHaveCount(1);
  await expect(page.locator('.download-row')).toContainText('Test Movie (2020)');
  await page.locator('#downloads-refresh').click();
  await expect(page.locator('.download-row')).toContainText('ratio 1.50');
  await page.locator('.download-row').evaluate(el => { (el as HTMLElement).dataset.probe = '1'; });
  await page.locator('#downloads-refresh').click();
  await expect(page.locator('.download-row')).toContainText('ratio 1.50');
  await expect(page.locator('.download-row')).toHaveAttribute('data-probe', '1');
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
  await expect(page.locator('.download-meta')).toContainText('Kept');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();

  await page.screenshot({ path: 'test-results/configuration-desktop-dashboard.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // A badge and an action button must not squeeze a card description into a
  // one-word-wide column.
  expect(await page.evaluate(() => {
    const heading = document.querySelector('#downloads-list')!.closest('.card')!.querySelector('.card-heading')!;
    const text = heading.querySelector('div')!;
    return text.getBoundingClientRect().width / heading.getBoundingClientRect().width;
  })).toBeGreaterThan(0.6);
  await page.screenshot({ path: 'test-results/configuration-mobile-dashboard.png', fullPage: true });
  await openSettings(page, 'Library');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/configuration-mobile-library.png' });
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Connections', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/configuration-mobile-connections.png' });

  const clearProvider = page.locator('.discovery-provider').first();
  await clearProvider.getByLabel('API key', { exact: true }).selectOption('clear');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await expect(clearProvider.getByLabel('API key', { exact: true }).locator('option:checked')).toHaveText('Leave unset');
  await page.locator('#settings-close').click();

  // Delete removes the download after confirmation.
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#downloads-feedback')).toContainText('Deletion could not be confirmed');
  await expect(page.locator('.download-row')).toHaveCount(1);
  await page.locator('#downloads-refresh').click();
  await expect(page.locator('.download-row')).toContainText('deleting');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.download-row')).toHaveCount(0);
  await expect(page.locator('#downloads-list')).toContainText('No downloads yet. Add a magnet');
  await expect(page.locator('#downloads-list')).toContainText('Check playback readiness in Settings.');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Administrator password')).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/admin/settings').then(r => r.status))).toBe(401);
  expect(errors).toEqual([]);
});

test('store tokens are shown once, revocable, and store limits persist', async ({ page }) => {
  await page.goto('/configure');
  await page.getByLabel('Administrator password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await openSettings(page);
  await page.locator('#operating-mode').selectOption('store');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByLabel('Store lease (days)').fill('7');
  await page.getByLabel('Maximum active store downloads').fill('35');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Access', exact: true }).click();
  await page.getByLabel('Token name', { exact: true }).fill('Browser client');
  await page.locator('#store-token-limits > summary').click();
  await page.getByLabel('Requests per minute').fill('30');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.locator('#store-token-secret')).toHaveValue(/^[\w-]{43}$/);
  const secret = await page.locator('#store-token-secret').inputValue();
  const added = await page.request.post('/store/v1/magnets', {
    headers: { Authorization: `Bearer ${secret}` }, data: { infoHash: 'a'.repeat(40) },
  });
  expect(added.status()).toBe(201);
  // Progress polling discovers API additions without a manual refresh.
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Files', exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.locator('.download-row', { hasText: 'paused' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).first().click();
  await expect(page.locator('.file-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Download file', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Selected', exact: true })).toHaveCount(2);

  // A stable permalink per file, copied to the clipboard, next to the
  // 24-hour-expiry note.
  await expect(page.locator('#download-files-dialog')).toContainText('"Copy permalink" gives a stable link');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.file-row').first().getByRole('button', { name: 'Copy permalink', exact: true }).click();
  await expect(page.locator('#download-files-feedback')).toContainText('Permalink copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^http:\/\/127\.0\.0\.1:17070\/api\/admin\/downloads\/[a-f0-9]{40}\/files\/0\/go$/);
  const permalinkResponse = await page.request.get(copied, { maxRedirects: 0 });
  expect(permalinkResponse.status()).toBe(302);
  expect(permalinkResponse.headers().location).toMatch(/^http:\/\/127\.0\.0\.1:17070\/api\/v1\/download\/[\w-]+\.[\w-]+$/);
  await page.locator('#download-files-close').click();
  await expect(page.locator('#download-files-dialog')).toBeHidden();

  await openSettings(page, 'Access');
  await page.locator('#check-playback').click();
  await expect(page.locator('#dashboard-checks')).toContainText('A qBittorrent file is readable');

  await page.screenshot({ path: 'test-results/store-desktop-dashboard.png', mask: [page.locator('#store-token-secret')] });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/store-mobile-dashboard.png', mask: [page.locator('#store-token-secret')] });
  await expect(page.locator('#store-token-list')).toContainText('Browser client');
  await page.getByRole('button', { name: 'Done copying' }).click();
  await expect(page.locator('#store-token-secret')).toHaveValue('');
  await page.reload();
  await openSettings(page, 'Access');
  await expect(page.locator('#store-token-list')).toContainText('Browser client');
  await expect(page.locator('#store-token-list')).toContainText('Access: read, write, link');
  await expect(page.locator('#store-token-list')).toContainText('Last used:');
  await expect(page.locator('#store-token-reveal')).toBeHidden();
  expect(await page.content()).not.toContain(secret);
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Library', exact: true }).click();
  await expect(page.getByLabel('Store lease (days)')).toHaveValue('7');
  await expect(page.getByLabel('Maximum active store downloads')).toHaveValue('35');
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Access', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.locator('#store-token-list')).toContainText('No API tokens');
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.locator('#operating-mode').selectOption('search');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#feedback')).toContainText('Settings saved');
  await page.locator('#settings-dialog').getByRole('tab', { name: 'Access', exact: true }).click();
  await expect(page.locator('#store-tokens-card')).toBeHidden();
});
