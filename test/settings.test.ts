import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { legacyBackendId } from '../src/backends/config.js';
import { applySettingsPatch, currentSettingsVersion, emptySettings, publicSettings, SettingsStore, SettingsValidationError, writeSettings } from '../src/settings.js';
import { openDatabase } from '../src/state/sqlite/db.js';
import { SqliteSettingsStore } from '../src/state/sqlite/settings.js';
import { tmpDir } from './helpers.js';

test('seeds once, persists edits, and ignores invalid environment seeds after restart', async t => {
  const dir = await tmpDir(t, 'debridarr-settings');
  const store = await SettingsStore.open(dir, { PROWLARR_URL: 'http://example.test/prowlarr/', PROWLARR_API_KEY: 'old-key' });
  const backendId = store.snapshot().downloadBackend.id;
  assert.match(backendId, /^[a-z0-9][a-z0-9-]{0,63}$/);
  const seeded = store.snapshot().discovery.providers;
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.url, 'http://example.test/prowlarr');
  assert.deepEqual(seeded[0]!.preferences, { languages: [], resolutions: [], codecs: [] });
  await store.update({
    discovery: { providers: [{ id: seeded[0]!.id, type: 'prowlarr', url: seeded[0]!.url, apiKey: 'new-key' }] },
    downloadBackend: { username: 'admin', password: ' spaced password ' },
  });
  const restarted = await SettingsStore.open(dir, { PROWLARR_URL: 'no-longer-valid', PROWLARR_API_KEY: 'old-key' });
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.equal(restarted.snapshot().downloadBackend.id, backendId);
  assert.equal(restarted.snapshot().downloadBackend.password, ' spaced password ');
  assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['settings.json']);
  const visible = publicSettings(store.snapshot());
  assert.equal(visible.discovery.providers[0]!.hasApiKey, true);
  assert.ok(!JSON.stringify(visible).includes('new-key'));
  await store.update({ discovery: { providers: [{ id: seeded[0]!.id, type: 'prowlarr', url: seeded[0]!.url, apiKey: null }] } });
  assert.equal(store.snapshot().discovery.providers[0]!.apiKey, '');
  assert.equal((await SettingsStore.open(dir, { PROWLARR_API_KEY: 'old-key' })).snapshot().discovery.providers[0]!.apiKey, '');
});

test('serialized writes merge with latest settings; failure preserves memory and disk and queue recovers', async t => {
  const dir = await tmpDir(t, 'debridarr-settings');
  let fail = false;
  const store = await SettingsStore.open(dir, {}, async (path, settings) => {
    if (fail) throw new Error('sensitive storage detail');
    await writeSettings(path, settings);
  });
  await Promise.all([
    store.update({ metadata: { tmdbApiKey: 'key' } }), store.update({ metadata: { provider: 'tmdb' } }),
  ]);
  assert.deepEqual(store.snapshot().metadata, { provider: 'tmdb', tmdbApiKey: 'key' });
  const before = await readFile(join(dir, 'settings.json'), 'utf8');
  fail = true;
  await assert.rejects(store.update({ metadata: { tmdbApiKey: 'lost-key' } }), /Previous settings remain active/);
  assert.equal(store.snapshot().metadata.tmdbApiKey, 'key');
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), before);
  fail = false;
  await store.update({ downloadBackend: { username: 'admin' } });
  assert.equal(store.snapshot().downloadBackend.username, 'admin');
  const snapshot = store.snapshot();
  snapshot.metadata.tmdbApiKey = 'mutated';
  assert.equal(store.snapshot().metadata.tmdbApiKey, 'key');
});

test('corrupt, incomplete, unsupported, and unreadable settings are not silently reset', async t => {
  const dir = await tmpDir(t, 'debridarr-settings');
  for (const contents of ['{broken', JSON.stringify({ version: 18, settings: emptySettings() }), '{"version":1,"settings":{}}']) {
    await writeFile(join(dir, 'settings.json'), contents);
    await assert.rejects(SettingsStore.open(dir, {}), /invalid or unsupported/);
    assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), contents);
  }
  await assert.rejects(SettingsStore.open(join(dir, 'settings.json', 'child'), {}), /Cannot read settings storage/);
});

test('invalid edits are rejected without exposing supplied secrets', () => {
  for (const input of [null, [], { other: {} },
    { discovery: { providers: [{ type: 'prowlarr', url: 'ftp://example.test' }] } },
    { discovery: { providers: [{ type: 'prowlarr', url: 'http://example.test', apiKey: 'secret\nvalue' }] } },
    { downloadBackend: { url: 'http://user:secret@example.test' } },
    { downloadBackend: { username: 123 } }, JSON.parse('{"discovery":{"__proto__":{}}}'),
    { metadata: { provider: 'omdb' } }, { metadata: { tmdbApiKey: '' } }, { metadata: { region: 'us' } },
    { discovery: { providers: [{ type: 'newznab', url: 'http://example.test', apiKey: 'k' }] } },
    { discovery: { providers: [{ type: 'prowlarr', url: 'ftp://example.test', apiKey: 'k' }] } },
    { discovery: { providers: [{ type: 'prowlarr', url: 'http://example.test', apiKey: 42 }] } },
    { discovery: { providers: [{ type: 'prowlarr', url: 'http://example.test', apiKey: 'k', extra: true }] } },
    { discovery: { providers: [{ id: 'Not Valid', type: 'prowlarr', url: 'http://example.test', apiKey: 'k' }] } },
    { discovery: { region: 'us' } }]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
});

test('metadata provider and TMDB key follow the same patch rules as other sections', () => {
  const withKey = applySettingsPatch(emptySettings(), { metadata: { provider: 'tmdb', tmdbApiKey: 'k3y' } });
  assert.deepEqual(withKey.metadata, { provider: 'tmdb', tmdbApiKey: 'k3y' });
  assert.equal(publicSettings(withKey).metadata.hasTmdbApiKey, true);
  assert.ok(!JSON.stringify(publicSettings(withKey)).includes('k3y'));
  // Omitted key is kept; null clears it; provider survives on its own.
  assert.equal(applySettingsPatch(withKey, { metadata: { provider: 'cinemeta' } }).metadata.tmdbApiKey, 'k3y');
  assert.equal(applySettingsPatch(withKey, { metadata: { tmdbApiKey: null } }).metadata.tmdbApiKey, '');
});

test('partial playback is explicitly opt-in', () => {
  assert.deepEqual(emptySettings().playback, { streamWhileDownloading: false });
  const enabled = applySettingsPatch(emptySettings(), { playback: { streamWhileDownloading: true } });
  assert.equal(enabled.playback.streamWhileDownloading, true);
  assert.equal(publicSettings(enabled).playback.streamWhileDownloading, true);
  for (const playback of [{ streamWhileDownloading: 'yes' }, { streamWhileDownloading: null }, { enabled: true }]) {
    assert.throws(() => applySettingsPatch(emptySettings(), { playback }), SettingsValidationError);
  }
});

test('retention defaults, field validation, and independence from the other sections', () => {
  assert.deepEqual(emptySettings().retention, { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0, storeLeaseDays: 14, minFreeSpaceGB: 1 });
  const updated = applySettingsPatch(emptySettings(), { retention: { days: 60, targetRatio: 2, graceDays: 7, extendOnPlay: false, maxCacheGB: 500, storeLeaseDays: 7 } });
  assert.deepEqual(updated.retention, { days: 60, targetRatio: 2, graceDays: 7, extendOnPlay: false, maxCacheGB: 500, storeLeaseDays: 7, minFreeSpaceGB: 1 });
  // Omitted fields are kept, same as the other sections.
  assert.equal(applySettingsPatch(updated, { retention: { days: 90 } }).retention.targetRatio, 2);
  assert.equal(applySettingsPatch(updated, { retention: { days: 90 } }).retention.storeLeaseDays, 7);
  for (const input of [
    { retention: { days: 0 } }, { retention: { days: 3651 } }, { retention: { days: 1.5 } },
    { retention: { targetRatio: 0 } }, { retention: { targetRatio: 101 } },
    { retention: { graceDays: -1 } }, { retention: { maxCacheGB: -1 } },
    { retention: { minFreeSpaceGB: -1 } }, { retention: { minFreeSpaceGB: '1' } },
    { retention: { storeLeaseDays: 0 } }, { retention: { storeLeaseDays: 1.5 } }, { retention: { storeLeaseDays: 3651 } },
    { retention: { extendOnPlay: 'yes' } }, { retention: { days: '30' } }, { retention: { region: 'us' } },
  ]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), SettingsValidationError);
  }
});

test('integrations.mode: default, enum validation, and independence from the other sections', () => {
  assert.deepEqual(emptySettings().integrations, { mode: 'search' });
  for (const mode of ['search', 'store', 'both'] as const) {
    assert.equal(applySettingsPatch(emptySettings(), { integrations: { mode } }).integrations.mode, mode);
  }
  // Setting the mode leaves other sections untouched.
  const withKey = applySettingsPatch(emptySettings(), { metadata: { provider: 'tmdb', tmdbApiKey: 'k3y' } });
  assert.equal(applySettingsPatch(withKey, { integrations: { mode: 'both' } }).metadata.tmdbApiKey, 'k3y');
  assert.equal(publicSettings(applySettingsPatch(emptySettings(), { integrations: { mode: 'store' } })).integrations.mode, 'store');
  for (const input of [
    { integrations: { mode: 'debrid' } }, { integrations: { mode: 'SEARCH' } }, { integrations: { mode: '' } },
    { integrations: { mode: 1 } }, { integrations: { mode: null } }, { integrations: { enabled: true } },
  ]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), SettingsValidationError);
  }
});

test('connections.webhookUrl / webhookSecret: HTTPS-only, secret keep/replace/clear, and independence from other sections', () => {
  assert.deepEqual(emptySettings().connections, { webhookUrl: '', webhookSecret: '' });
  const withHook = applySettingsPatch(emptySettings(), { connections: { webhookUrl: 'https://example.test/hooks/debridarr', webhookSecret: 's3cret' } });
  assert.equal(withHook.connections.webhookUrl, 'https://example.test/hooks/debridarr');
  assert.equal(withHook.connections.webhookSecret, 's3cret');
  const visible = publicSettings(withHook);
  assert.deepEqual(visible.connections, { webhookUrl: 'https://example.test/hooks/debridarr', hasWebhookSecret: true });
  assert.ok(!JSON.stringify(visible).includes('s3cret'));
  // Omitted fields are kept; a blank URL clears it; null clears the secret; setting one leaves the other alone.
  assert.equal(applySettingsPatch(withHook, { connections: { webhookUrl: '' } }).connections.webhookUrl, '');
  assert.equal(applySettingsPatch(withHook, { connections: { webhookUrl: '' } }).connections.webhookSecret, 's3cret');
  assert.equal(applySettingsPatch(withHook, { connections: { webhookSecret: null } }).connections.webhookSecret, '');
  assert.equal(applySettingsPatch(withHook, { connections: { webhookSecret: null } }).connections.webhookUrl, 'https://example.test/hooks/debridarr');
  // Trailing slash is normalized, same as other saved URLs.
  assert.equal(applySettingsPatch(emptySettings(), { connections: { webhookUrl: 'https://example.test/hooks/' } }).connections.webhookUrl, 'https://example.test/hooks');
  // Setting a webhook leaves other sections untouched.
  const withKey = applySettingsPatch(emptySettings(), { metadata: { provider: 'tmdb', tmdbApiKey: 'k3y' } });
  assert.equal(applySettingsPatch(withKey, { connections: { webhookUrl: 'https://example.test' } }).metadata.tmdbApiKey, 'k3y');
  for (const input of [
    { connections: { webhookUrl: 'http://example.test' } }, // HTTPS only
    { connections: { webhookUrl: 'https://user:pass@example.test' } },
    { connections: { webhookUrl: 'https://example.test?a=1' } },
    { connections: { webhookUrl: 'https://example.test#frag' } },
    { connections: { webhookUrl: 'not a url' } },
    { connections: { webhookUrl: 123 } },
    { connections: { webhookSecret: '' } }, // omit to keep, null to clear
    { connections: { webhookSecret: 'has\ncontrol' } },
    { connections: { region: 'us' } },
  ]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), SettingsValidationError);
  }
});

test('rss.searches: feed URL keeps its query string, defaults, id preservation, and caps', () => {
  assert.deepEqual(emptySettings().rss, { searches: [] });
  const added = applySettingsPatch(emptySettings(), { rss: { searches: [
    { feedUrl: 'http://indexer.test/rss?t=search&apikey=k3y', protocol: 'torrent' },
  ] } });
  assert.equal(added.rss.searches.length, 1);
  const search = added.rss.searches[0]!;
  assert.match(search.id, /^[a-z0-9-]+$/);
  // A query string (the search + embedded key) survives; http is allowed.
  assert.equal(search.feedUrl, 'http://indexer.test/rss?t=search&apikey=k3y');
  assert.deepEqual({ ...search, id: undefined }, {
    id: undefined, feedUrl: 'http://indexer.test/rss?t=search&apikey=k3y', protocol: 'torrent',
    titleInclude: '', titleExclude: '', cachedOnly: false, queue: false, enabled: true,
  });
  const visible = publicSettings(added).rss;
  assert.deepEqual(visible, { searches: [search] });

  // Re-supplying the id keeps omitted fields (filters, flags) as saved.
  const filtered = applySettingsPatch(added, { rss: { searches: [
    { id: search.id, feedUrl: search.feedUrl, protocol: 'torrent', titleInclude: 'x265', cachedOnly: true, enabled: false },
  ] } });
  assert.deepEqual(filtered.rss.searches[0], { ...search, titleInclude: 'x265', cachedOnly: true, enabled: false });
  const kept = applySettingsPatch(filtered, { rss: { searches: [{ id: search.id, feedUrl: search.feedUrl, protocol: 'usenet' }] } });
  assert.equal(kept.rss.searches[0]!.protocol, 'usenet');
  assert.equal(kept.rss.searches[0]!.titleInclude, 'x265', 'omitted fields are kept, same as discovery providers');
  assert.equal(kept.rss.searches[0]!.cachedOnly, true);
  assert.equal(kept.rss.searches[0]!.enabled, false);

  assert.deepEqual(applySettingsPatch(added, { rss: { searches: [] } }).rss.searches, []);
  assert.throws(() => applySettingsPatch(emptySettings(), {
    rss: { searches: Array.from({ length: 21 }, () => ({ feedUrl: 'http://indexer.test/rss', protocol: 'torrent' })) },
  }), SettingsValidationError);
  assert.throws(() => applySettingsPatch(emptySettings(), {
    rss: { searches: [{ id: 'dup', feedUrl: 'http://a.test', protocol: 'torrent' }, { id: 'dup', feedUrl: 'http://b.test', protocol: 'torrent' }] },
  }), SettingsValidationError);
  for (const input of [
    { rss: { searches: [{ protocol: 'torrent' }] } }, // feedUrl required
    { rss: { searches: [{ feedUrl: 'http://indexer.test' }] } }, // protocol required
    { rss: { searches: [{ feedUrl: 'http://indexer.test', protocol: 'usenet2' }] } },
    { rss: { searches: [{ feedUrl: '', protocol: 'torrent' }] } },
    { rss: { searches: [{ feedUrl: 'not a url', protocol: 'torrent' }] } },
    { rss: { searches: [{ feedUrl: 'http://user:pass@indexer.test', protocol: 'torrent' }] } },
    { rss: { searches: [{ feedUrl: 'ftp://indexer.test', protocol: 'torrent' }] } },
    { rss: { searches: [{ feedUrl: 'http://indexer.test', protocol: 'torrent', titleInclude: 'has\ncontrol' }] } },
    { rss: { searches: [{ feedUrl: 'http://indexer.test', protocol: 'torrent', cachedOnly: 'yes' }] } },
    { rss: { searches: [{ feedUrl: 'http://indexer.test', protocol: 'torrent', extra: true }] } },
    { rss: { region: 'us' } },
  ]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), SettingsValidationError);
  }
});

test('DEBRIDARR_MODE seeds integrations.mode on a fresh install only', async t => {
  const dir = await tmpDir(t, 'debridarr-settings');
  const store = await SettingsStore.open(dir, { DEBRIDARR_MODE: 'both' });
  assert.equal(store.snapshot().integrations.mode, 'both');
  const restarted = await SettingsStore.open(dir, { DEBRIDARR_MODE: 'store' });
  assert.equal(restarted.snapshot().integrations.mode, 'both', 'env is ignored once settings.json exists');
});

test('discovery provider preferences are allow-sets: defaults, array validation, dedupe, and per-provider independence', () => {
  const added = applySettingsPatch(emptySettings(), { discovery: { providers: [{ type: 'prowlarr', url: 'http://prowlarr.test', apiKey: 'k' }] } });
  const id = added.discovery.providers[0]!.id;
  assert.deepEqual(added.discovery.providers[0]!.preferences, { languages: [], resolutions: [], codecs: [] });
  const updated = applySettingsPatch(added, { discovery: { providers: [{ id, type: 'prowlarr', url: 'http://prowlarr.test', preferences: { languages: ['fr', 'de'], resolutions: [2160, 1080], codecs: ['x265'] } }] } });
  assert.deepEqual(updated.discovery.providers[0]!.preferences, { languages: ['fr', 'de'], resolutions: [2160, 1080], codecs: ['x265'] });
  // Omitted fields are kept, same as the other sections; the array is replaced wholesale, not merged.
  assert.deepEqual(applySettingsPatch(updated, { discovery: { providers: [{ id, type: 'prowlarr', url: 'http://prowlarr.test', preferences: { languages: ['ja'] } }] } }).discovery.providers[0]!.preferences,
    { languages: ['ja'], resolutions: [2160, 1080], codecs: ['x265'] });
  // Omitting preferences entirely keeps the saved allow-sets.
  assert.deepEqual(applySettingsPatch(updated, { discovery: { providers: [{ id, type: 'prowlarr', url: 'http://prowlarr.test' }] } }).discovery.providers[0]!.preferences,
    { languages: ['fr', 'de'], resolutions: [2160, 1080], codecs: ['x265'] });
  // Duplicates are deduped.
  assert.deepEqual(applySettingsPatch(added, { discovery: { providers: [{ id, type: 'prowlarr', url: 'http://prowlarr.test', preferences: { languages: ['fr', 'fr'], resolutions: [1080, 1080], codecs: ['x265', 'x265'] } }] } }).discovery.providers[0]!.preferences,
    { languages: ['fr'], resolutions: [1080], codecs: ['x265'] });
  for (const preferences of [
    { languages: ['eng'] }, { languages: ['F'] }, { languages: ['FR'] },
    { languages: [1] }, { languages: 'fr' },
    { resolutions: [900] }, { resolutions: ['1080'] }, { resolutions: 1080 },
    { codecs: ['h265'] }, { codecs: ['X265'] }, { codecs: 'x265' },
    { region: 'us' },
  ]) {
    assert.throws(() => applySettingsPatch(added, { discovery: { providers: [{ id, type: 'prowlarr', url: 'http://prowlarr.test', preferences }] } }), SettingsValidationError);
  }
  // Preferences are per-provider: one provider's filters never leak into another.
  const two = applySettingsPatch(added, { discovery: { providers: [
    { id, type: 'prowlarr', url: 'http://prowlarr.test', preferences: { languages: ['fr'] } },
    { type: 'torznab', url: 'http://indexer.test' },
  ] } });
  assert.deepEqual(two.discovery.providers[1]!.preferences, { languages: [], resolutions: [], codecs: [] });
});

test('discovery.providers: defaults, id assignment and preservation, masking, and caps', () => {
  assert.deepEqual(emptySettings().discovery, { providers: [] });
  const added = applySettingsPatch(emptySettings(), { discovery: { providers: [{ type: 'prowlarr', url: 'http://prowlarr.test', apiKey: 'k3y' }] } });
  assert.equal(added.discovery.providers.length, 1);
  const provider = added.discovery.providers[0]!;
  assert.match(provider.id, /^[a-z0-9-]+$/);
  assert.equal(provider.url, 'http://prowlarr.test');
  const visible = publicSettings(added);
  assert.deepEqual(visible.discovery.providers, [{ id: provider.id, type: 'prowlarr', url: 'http://prowlarr.test', hasApiKey: true, preferences: { languages: [], resolutions: [], codecs: [] } }]);
  assert.ok(!JSON.stringify(visible).includes('k3y'));
  // Re-supplying the id keeps it and its omitted secret and preferences stable.
  // A string replaces the secret, null clears it, and the array is replaced wholesale.
  const filtered = applySettingsPatch(added, { discovery: { providers: [{ id: provider.id, type: 'prowlarr', url: 'http://prowlarr.test', preferences: { resolutions: [1080] } }] } });
  const kept = applySettingsPatch(filtered, { discovery: { providers: [{ id: provider.id, type: 'prowlarr', url: 'http://other.test' }] } });
  assert.equal(kept.discovery.providers[0]!.id, provider.id);
  assert.equal(kept.discovery.providers[0]!.apiKey, 'k3y');
  assert.deepEqual(kept.discovery.providers[0]!.preferences, { languages: [], resolutions: [1080], codecs: [] });
  assert.equal(applySettingsPatch(kept, { discovery: { providers: [{ id: provider.id, type: 'prowlarr', url: 'http://other.test', apiKey: 'new-key' }] } }).discovery.providers[0]!.apiKey, 'new-key');
  assert.equal(applySettingsPatch(kept, { discovery: { providers: [{ id: provider.id, type: 'prowlarr', url: 'http://other.test', apiKey: null }] } }).discovery.providers[0]!.apiKey, '');
  assert.equal(applySettingsPatch(emptySettings(), { discovery: { providers: [{ type: 'torznab', url: 'http://indexer.test' }] } }).discovery.providers[0]!.apiKey, '');
  assert.deepEqual(applySettingsPatch(added, { discovery: { providers: [] } }).discovery.providers, []);
  assert.throws(() => applySettingsPatch(emptySettings(), {
    discovery: { providers: Array.from({ length: 11 }, () => ({ type: 'prowlarr', url: '', apiKey: 'k' })) },
  }), SettingsValidationError);
  assert.throws(() => applySettingsPatch(emptySettings(), {
    discovery: { providers: [{ id: 'dup', type: 'prowlarr', url: '', apiKey: 'k' }, { id: 'dup', type: 'prowlarr', url: '', apiKey: 'k' }] },
  }), SettingsValidationError);
});

// Each historical shape uses the same read / save / reopen contract.
const connections = {
  prowlarr: { url: 'http://prowlarr.test', apiKey: 'legacy-key' },
  qbittorrent: { url: '', username: '', password: '' },
};
const metadata = { provider: 'cinemeta', tmdbApiKey: '' };
const retention = { days: 45, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 };
const preferences = { languages: ['fr'], resolutions: [1080, 2160], codecs: ['x265'] };
const playback = { streamWhileDownloading: true };
const base = { ...connections, metadata, retention };
const versions = [
  { version: 1, settings: connections },
  { version: 2, settings: { ...connections, metadata } },
  { version: 3, settings: base },
  { version: 4, settings: { ...base, preferences: { language: 'fr', requireLanguage: true, maxResolution: 1080 } },
    preferences: { languages: ['fr'], resolutions: [480, 720, 1080], codecs: [] } },
  { version: 4, settings: { ...base, preferences: { language: 'fr', requireLanguage: false, maxResolution: 0 } } },
  { version: 5, settings: { ...base, preferences: { languages: ['fr'], resolutions: [1080, 2160] } },
    preferences: { ...preferences, codecs: [] } },
  { version: 6, settings: { ...base, preferences }, preferences },
  { version: 7, settings: { ...base, preferences, retention: { ...retention, storeLeaseDays: 7 }, integrations: { mode: 'both' } }, preferences },
  { version: 9, settings: { ...base, preferences, retention: { ...retention, storeLeaseDays: 7 }, integrations: { mode: 'both' }, store: { maxActiveDownloads: 35 }, setup: { completed: true } }, preferences },
  { version: 8, settings: { ...base, preferences, retention: { ...retention, storeLeaseDays: 7 }, integrations: { mode: 'both' }, store: { maxActiveDownloads: 35 } }, preferences },
  { version: 10, settings: { ...base, preferences, retention: { ...retention, storeLeaseDays: 7, minFreeSpaceGB: 2 }, integrations: { mode: 'both' }, store: { maxActiveDownloads: 35 }, setup: { completed: true } }, preferences },
  { version: 11, settings: { ...base, preferences, retention: { ...retention, storeLeaseDays: 7, minFreeSpaceGB: 2 }, integrations: { mode: 'both' }, store: { maxActiveDownloads: 35 }, setup: { completed: true }, playback }, preferences },
  { version: 13, settings: {
    prowlarr: connections.prowlarr, metadata, retention: { ...retention, storeLeaseDays: 7, minFreeSpaceGB: 2 }, preferences,
    integrations: { mode: 'both' }, store: { maxActiveDownloads: 35 }, setup: { completed: true }, playback,
    downloadBackend: { id: 'default', type: 'qbittorrent', url: '', username: '', password: '', pathMappings: [] }, discovery: { providers: [] },
  }, preferences },
  { version: 14, settings: {
    prowlarr: connections.prowlarr, metadata, retention: { ...retention, storeLeaseDays: 7, minFreeSpaceGB: 2 }, preferences,
    integrations: { mode: 'both' }, store: { maxActiveDownloads: 35 }, setup: { completed: true }, playback,
    downloadBackend: { id: 'default', type: 'qbittorrent', protocol: 'torrent', url: '', username: '', password: '', pathMappings: [] }, discovery: { providers: [] },
  }, preferences },
];

test('all saved schemas preserve settings, apply new defaults, and migrate only on save', async t => {
  const dir = await tmpDir(t, 'debridarr-migrations');
  for (const legacy of versions) {
    const path = join(dir, 'settings.json');
    const original = JSON.stringify({ version: legacy.version, settings: legacy.settings });
    await writeFile(path, original);
    const store = await SettingsStore.open(dir, { METADATA_PROVIDER: 'tmdb', DEBRIDARR_MODE: 'store' });
    const snapshot = store.snapshot();
    assert.equal(snapshot.discovery.providers.length, 1, `schema ${legacy.version}`);
    assert.match(snapshot.discovery.providers[0]!.id, /^[a-z0-9-]+$/);
    const { id: _id, ...provider } = snapshot.discovery.providers[0]!;
    assert.deepEqual(provider, {
      type: 'prowlarr', url: connections.prowlarr.url, apiKey: connections.prowlarr.apiKey,
      preferences: legacy.preferences ?? { languages: [], resolutions: [], codecs: [] },
    }, `schema ${legacy.version}`);
    assert.deepEqual({ ...snapshot, discovery: { providers: [] } }, {
      ...emptySettings(), metadata,
      retention: { ...retention, days: legacy.version >= 3 ? 45 : 30, storeLeaseDays: legacy.version >= 7 ? 7 : 14, minFreeSpaceGB: legacy.version >= 10 ? 2 : 0 },
      integrations: { mode: legacy.version >= 7 ? 'both' : 'search' },
      store: { maxActiveDownloads: legacy.version >= 8 ? 35 : 20 },
      setup: { completed: true },
      playback: legacy.version >= 11 ? playback : { streamWhileDownloading: false },
    }, `schema ${legacy.version}`);
    assert.equal(await readFile(path, 'utf8'), original, 'reading never rewrites a legacy file');
    await store.update({ retention: { days: 60 } });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.version, 17);
    assert.equal(saved.settings.retention.days, 60);
    assert.deepEqual((await SettingsStore.open(dir, {})).snapshot(), store.snapshot());
  }
});

// A regression test: SqliteSettingsStore.open() once parsed its `data` column
// straight into Settings with no version check at all, so a row saved by an
// older release (missing a section a later release added — connections, rss)
// crashed every read with "Cannot read properties of undefined" instead of
// migrating, exactly like settings.json already does. Same historical shapes
// as the JSON test above, same expected result, proven against the real
// SQLite driver instead of assumed from the JSON one.
test('SQLite driver migrates every legacy schema on open, exactly like the JSON driver', async t => {
  for (const legacy of versions) {
    const dir = await tmpDir(t, 'debridarr-sqlite-migrations');
    const db = openDatabase(dir);
    t.after(() => db.close());
    db.prepare('INSERT INTO settings (id, version, data) VALUES (1, ?, ?)').run(legacy.version, JSON.stringify(legacy.settings));

    const store = SqliteSettingsStore.open(db, { METADATA_PROVIDER: 'tmdb', DEBRIDARR_MODE: 'store' });
    const snapshot = store.snapshot();
    assert.equal(snapshot.discovery.providers.length, 1, `schema ${legacy.version}`);
    assert.match(snapshot.discovery.providers[0]!.id, /^[a-z0-9-]+$/);
    const { id: _id, ...provider } = snapshot.discovery.providers[0]!;
    assert.deepEqual(provider, {
      type: 'prowlarr', url: connections.prowlarr.url, apiKey: connections.prowlarr.apiKey,
      preferences: legacy.preferences ?? { languages: [], resolutions: [], codecs: [] },
    }, `schema ${legacy.version}`);
    assert.deepEqual({ ...snapshot, discovery: { providers: [] } }, {
      ...emptySettings(), metadata,
      retention: { ...retention, days: legacy.version >= 3 ? 45 : 30, storeLeaseDays: legacy.version >= 7 ? 7 : 14, minFreeSpaceGB: legacy.version >= 10 ? 2 : 0 },
      integrations: { mode: legacy.version >= 7 ? 'both' : 'search' },
      store: { maxActiveDownloads: legacy.version >= 8 ? 35 : 20 },
      setup: { completed: true },
      playback: legacy.version >= 11 ? playback : { streamWhileDownloading: false },
    }, `schema ${legacy.version}`);
    // Reading never rewrites the row; the current shape lands on the next save.
    const untouched = db.prepare('SELECT version, data FROM settings WHERE id = 1').get() as { version: number; data: string };
    assert.equal(untouched.version, legacy.version);
    assert.deepEqual(JSON.parse(untouched.data), legacy.settings);

    await store.update({ retention: { days: 60 } });
    const saved = db.prepare('SELECT version, data FROM settings WHERE id = 1').get() as { version: number; data: string };
    assert.equal(saved.version, currentSettingsVersion);
    assert.equal(JSON.parse(saved.data).retention.days, 60);
  }
});

test('legacy backend ownership is retained while connection details and path mappings change', async t => {
  const dir = await tmpDir(t, 'debridarr-backend-migration');
  const oldUrl = 'http://qbittorrent.test:8080';
  const legacy = versions.find(candidate => candidate.version === 11)!;
  await writeFile(join(dir, 'settings.json'), JSON.stringify({
    version: 11,
    settings: { ...legacy.settings, qbittorrent: { url: oldUrl, username: 'admin', password: 'saved-password' } },
  }));
  const store = await SettingsStore.open(dir, {});
  const expectedId = legacyBackendId(oldUrl);
  assert.equal(store.snapshot().downloadBackend.id, expectedId);
  assert.equal(store.snapshot().downloadBackend.type, 'qbittorrent');
  assert.deepEqual(store.snapshot().downloadBackend.pathMappings, []);

  await store.update({ downloadBackend: {
    url: 'http://new-qbittorrent.test:8080',
    pathMappings: [{ remote: '/remote/downloads/', local: '/downloads/' }],
  } });
  assert.equal(store.snapshot().downloadBackend.id, expectedId);
  assert.deepEqual(store.snapshot().downloadBackend.pathMappings, [{ remote: '/remote/downloads', local: '/downloads' }]);
  assert.equal(publicSettings(store.snapshot()).downloadBackend.hasPassword, true);
  assert.ok(!JSON.stringify(publicSettings(store.snapshot())).includes('saved-password'));
  assert.equal((await SettingsStore.open(dir, {})).snapshot().downloadBackend.id, expectedId);

  for (const downloadBackend of [
    { id: 'replacement' },
    { pathMappings: [{ remote: 'relative', local: '/downloads' }] },
    { pathMappings: [{ remote: '/remote/./downloads', local: '/downloads' }] },
    { pathMappings: [{ remote: '/remote', local: '/downloads' }, { remote: '/remote', local: '/other' }] },
  ]) await assert.rejects(store.update({ downloadBackend }), SettingsValidationError);

  const previousId = store.snapshot().downloadBackend.id;
  await store.update({ downloadBackend: { type: 'deluge', url: 'http://deluge.test:8112', password: 'deluge' } });
  assert.equal(store.snapshot().downloadBackend.type, 'deluge');
  assert.equal(store.snapshot().downloadBackend.protocol, 'torrent');
  assert.notEqual(store.snapshot().downloadBackend.id, previousId);
  const delugeId = store.snapshot().downloadBackend.id;
  await store.update({ downloadBackend: { type: 'sabnzbd', url: 'http://sabnzbd.test:8080', password: 'api-key' } });
  assert.equal(store.snapshot().downloadBackend.type, 'sabnzbd');
  assert.equal(store.snapshot().downloadBackend.protocol, 'usenet');
  assert.notEqual(store.snapshot().downloadBackend.id, delugeId);
});

test('store download limits validate and persist live changes', async t => {
  const dir = await tmpDir(t, 'debridarr-v7');
  const store = await SettingsStore.open(dir, {});
  assert.equal(store.snapshot().store.maxActiveDownloads, 20);
  for (const value of [0, 1001, 1.1, '20', null]) await assert.rejects(store.update({ store: { maxActiveDownloads: value } }));
  await store.update({ store: { maxActiveDownloads: 35 } });
  assert.equal((await SettingsStore.open(dir, {})).snapshot().store.maxActiveDownloads, 35);
});


test('first-run setup persists completion and upgrades do not reopen the guide', async t => {
  const dir = await tmpDir(t, 'debridarr-setup');
  const store = await SettingsStore.open(dir, {});
  assert.equal(store.snapshot().setup.completed, false);
  assert.equal(publicSettings(store.snapshot()).setup.completed, false);
  for (const setup of [{ completed: 'yes' }, { completed: null }, { step: 1 }]) await assert.rejects(store.update({ setup }));
  await store.update({ setup: { completed: true } });
  assert.equal((await SettingsStore.open(dir, {})).snapshot().setup.completed, true);
  await store.update({ setup: { completed: false } });
  assert.equal((await SettingsStore.open(dir, {})).snapshot().setup.completed, false);
});
