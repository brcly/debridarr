import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applySettingsPatch, emptySettings, publicSettings, SettingsStore, SettingsValidationError, writeSettings } from '../src/settings.js';

test('seeds once, persists edits, and ignores invalid environment seeds after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await SettingsStore.open(dir, { PROWLARR_URL: 'http://example.test/prowlarr/', PROWLARR_API_KEY: 'old-key' });
  assert.equal(store.snapshot().prowlarr.url, 'http://example.test/prowlarr');
  await store.update({ prowlarr: { apiKey: 'new-key' }, qbittorrent: { username: 'admin', password: ' spaced password ' } });
  const restarted = await SettingsStore.open(dir, { PROWLARR_URL: 'no-longer-valid', PROWLARR_API_KEY: 'old-key' });
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.equal(restarted.snapshot().qbittorrent.password, ' spaced password ');
  assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['settings.json']);
  const visible = publicSettings(store.snapshot());
  assert.equal(visible.prowlarr.hasApiKey, true);
  assert.ok(!JSON.stringify(visible).includes('new-key'));
  await store.update({ prowlarr: { apiKey: null } });
  assert.equal(store.snapshot().prowlarr.apiKey, '');
  assert.equal((await SettingsStore.open(dir, { PROWLARR_API_KEY: 'old-key' })).snapshot().prowlarr.apiKey, '');
});

test('serialized writes merge with latest settings; failure preserves memory and disk and queue recovers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let fail = false;
  const store = await SettingsStore.open(dir, {}, async (path, settings) => {
    if (fail) throw new Error('sensitive storage detail');
    await writeSettings(path, settings);
  });
  await Promise.all([
    store.update({ prowlarr: { apiKey: 'key' } }), store.update({ prowlarr: { url: 'http://example.test' } }),
  ]);
  assert.deepEqual(store.snapshot().prowlarr, { apiKey: 'key', url: 'http://example.test' });
  const before = await readFile(join(dir, 'settings.json'), 'utf8');
  fail = true;
  await assert.rejects(store.update({ prowlarr: { apiKey: 'lost-key' } }), /Previous settings remain active/);
  assert.equal(store.snapshot().prowlarr.apiKey, 'key');
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), before);
  fail = false;
  await store.update({ qbittorrent: { username: 'admin' } });
  assert.equal(store.snapshot().qbittorrent.username, 'admin');
  const snapshot = store.snapshot();
  snapshot.prowlarr.apiKey = 'mutated';
  assert.equal(store.snapshot().prowlarr.apiKey, 'key');
});

test('corrupt, incomplete, unsupported, and unreadable settings are not silently reset', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const contents of ['{broken', JSON.stringify({ version: 9, settings: emptySettings() }), '{"version":1,"settings":{}}']) {
    await writeFile(join(dir, 'settings.json'), contents);
    await assert.rejects(SettingsStore.open(dir, {}), /invalid or unsupported/);
    assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), contents);
  }
  await assert.rejects(SettingsStore.open(join(dir, 'settings.json', 'child'), {}), /Cannot read settings storage/);
});

test('invalid edits are rejected without exposing supplied secrets', () => {
  for (const input of [null, [], { other: {} }, { prowlarr: { url: 'ftp://example.test' } },
    { prowlarr: { apiKey: '' } }, { prowlarr: { apiKey: 'secret\nvalue' } },
    { qbittorrent: { url: 'http://user:secret@example.test' } },
    { qbittorrent: { username: 123 } }, JSON.parse('{"prowlarr":{"__proto__":{}}}'),
    { metadata: { provider: 'omdb' } }, { metadata: { tmdbApiKey: '' } }, { metadata: { region: 'us' } }]) {
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

test('retention defaults, field validation, and independence from the other sections', () => {
  assert.deepEqual(emptySettings().retention, { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 });
  const updated = applySettingsPatch(emptySettings(), { retention: { days: 60, targetRatio: 2, graceDays: 7, extendOnPlay: false, maxCacheGB: 500 } });
  assert.deepEqual(updated.retention, { days: 60, targetRatio: 2, graceDays: 7, extendOnPlay: false, maxCacheGB: 500 });
  // Omitted fields are kept, same as the other sections.
  assert.equal(applySettingsPatch(updated, { retention: { days: 90 } }).retention.targetRatio, 2);
  for (const input of [
    { retention: { days: 0 } }, { retention: { days: 3651 } }, { retention: { days: 1.5 } },
    { retention: { targetRatio: 0 } }, { retention: { targetRatio: 101 } },
    { retention: { graceDays: -1 } }, { retention: { maxCacheGB: -1 } },
    { retention: { extendOnPlay: 'yes' } }, { retention: { days: '30' } }, { retention: { region: 'us' } },
  ]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), SettingsValidationError);
  }
});

test('preferences are allow-sets: defaults, array validation, dedupe, and independence from the other sections', () => {
  assert.deepEqual(emptySettings().preferences, { languages: [], resolutions: [], codecs: [] });
  const updated = applySettingsPatch(emptySettings(), { preferences: { languages: ['fr', 'de'], resolutions: [2160, 1080], codecs: ['x265'] } });
  assert.deepEqual(updated.preferences, { languages: ['fr', 'de'], resolutions: [2160, 1080], codecs: ['x265'] });
  // Omitted fields are kept, same as the other sections; each field is replaced wholesale, not merged.
  assert.deepEqual(applySettingsPatch(updated, { preferences: { languages: ['ja'] } }).preferences,
    { languages: ['ja'], resolutions: [2160, 1080], codecs: ['x265'] });
  // Duplicates are deduped.
  assert.deepEqual(applySettingsPatch(emptySettings(), { preferences: { languages: ['fr', 'fr'], resolutions: [1080, 1080], codecs: ['x265', 'x265'] } }).preferences,
    { languages: ['fr'], resolutions: [1080], codecs: ['x265'] });
  for (const input of [
    { preferences: { languages: ['eng'] } }, { preferences: { languages: ['F'] } }, { preferences: { languages: ['FR'] } },
    { preferences: { languages: [1] } }, { preferences: { languages: 'fr' } },
    { preferences: { resolutions: [900] } }, { preferences: { resolutions: ['1080'] } }, { preferences: { resolutions: 1080 } },
    { preferences: { codecs: ['h265'] } }, { preferences: { codecs: ['X265'] } }, { preferences: { codecs: 'x265' } },
    { preferences: { region: 'us' } },
  ]) {
    assert.throws(() => applySettingsPatch(emptySettings(), input), SettingsValidationError);
  }
});

test('a version 2 settings file is read and upgraded straight to the current version on the next save', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const v2 = { version: 2, settings: {
    prowlarr: { url: '', apiKey: '' },
    qbittorrent: { url: '', username: '', password: '' },
    metadata: { provider: 'cinemeta', tmdbApiKey: '' },
  } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(v2, null, 2));
  const store = await SettingsStore.open(dir, {});
  assert.deepEqual(store.snapshot().retention, emptySettings().retention, 'retention defaults applied to a v2 file');
  assert.deepEqual(store.snapshot().preferences, emptySettings().preferences, 'preferences defaults applied to a v2 file');
  assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).version, 2, 'not rewritten until a change');
  await store.update({ retention: { days: 45 } });
  const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 6);
  assert.equal(saved.settings.retention.days, 45);
  assert.deepEqual((await SettingsStore.open(dir, {})).snapshot(), store.snapshot());
});

test('a version 3 settings file is read and upgraded straight to the current version on the next save', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const v3 = { version: 3, settings: {
    prowlarr: { url: '', apiKey: '' },
    qbittorrent: { url: '', username: '', password: '' },
    metadata: { provider: 'cinemeta', tmdbApiKey: '' },
    retention: { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 },
  } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(v3, null, 2));
  const store = await SettingsStore.open(dir, {});
  assert.deepEqual(store.snapshot().preferences, emptySettings().preferences, 'preferences defaults applied to a v3 file');
  assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).version, 3, 'not rewritten until a change');
  await store.update({ preferences: { languages: ['ja'] } });
  const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 6);
  assert.deepEqual(saved.settings.preferences.languages, ['ja']);
  assert.deepEqual((await SettingsStore.open(dir, {})).snapshot(), store.snapshot());
});

test('a version 4 settings file is migrated straight to version 6 allow-sets, preserving filtering behavior', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    prowlarr: { url: '', apiKey: '' },
    qbittorrent: { url: '', username: '', password: '' },
    metadata: { provider: 'cinemeta', tmdbApiKey: '' },
    retention: { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 },
  };
  const v4 = { version: 4, settings: { ...base, preferences: { language: 'fr', requireLanguage: true, maxResolution: 1080 } } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(v4, null, 2));
  const store = await SettingsStore.open(dir, {});
  // A cap becomes exactly the set of resolutions it used to let through; a required language carries over
  // unchanged; there was no codec concept yet, so it comes through unfiltered.
  assert.deepEqual(store.snapshot().preferences, { languages: ['fr'], resolutions: [480, 720, 1080], codecs: [] });
  await store.update({ preferences: { languages: ['fr', 'de'] } });
  const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 6);
  assert.deepEqual(saved.settings.preferences, { languages: ['fr', 'de'], resolutions: [480, 720, 1080], codecs: [] });

  const dir2 = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir2, { recursive: true, force: true }));
  const notRequired = { version: 4, settings: { ...base, preferences: { language: 'fr', requireLanguage: false, maxResolution: 0 } } };
  await writeFile(join(dir2, 'settings.json'), JSON.stringify(notRequired, null, 2));
  const store2 = await SettingsStore.open(dir2, {});
  // A non-required language never excluded anything; there's no "soft preference" left to carry it into, so it becomes no filter.
  assert.deepEqual(store2.snapshot().preferences, { languages: [], resolutions: [], codecs: [] });
});

test('a version 5 settings file is migrated to version 6, adding an unfiltered codecs set', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const v5 = { version: 5, settings: {
    prowlarr: { url: '', apiKey: '' },
    qbittorrent: { url: '', username: '', password: '' },
    metadata: { provider: 'cinemeta', tmdbApiKey: '' },
    retention: { days: 30, targetRatio: 1, graceDays: 0, extendOnPlay: true, maxCacheGB: 0 },
    preferences: { languages: ['fr'], resolutions: [1080, 2160] },
  } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(v5, null, 2));
  const store = await SettingsStore.open(dir, {});
  assert.deepEqual(store.snapshot().preferences, { languages: ['fr'], resolutions: [1080, 2160], codecs: [] });
  await store.update({ preferences: { codecs: ['x265'] } });
  const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 6);
  assert.deepEqual(saved.settings.preferences, { languages: ['fr'], resolutions: [1080, 2160], codecs: ['x265'] });
});

test('a version 1 settings file is read and upgraded straight to the current version on the next save', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'debridarr-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = { version: 1, settings: {
    prowlarr: { url: 'http://prowlarr.test', apiKey: 'legacy-key' },
    qbittorrent: { url: '', username: '', password: '' },
  } };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(legacy, null, 2));
  const store = await SettingsStore.open(dir, { METADATA_PROVIDER: 'tmdb' });
  assert.deepEqual(store.snapshot().metadata, { provider: 'cinemeta', tmdbApiKey: '' }, 'env seeds do not apply to an existing file');
  assert.deepEqual(store.snapshot().retention, emptySettings().retention, 'retention defaults applied to a v1 file');
  assert.deepEqual(store.snapshot().preferences, emptySettings().preferences, 'preferences defaults applied to a v1 file');
  assert.equal(store.snapshot().prowlarr.apiKey, 'legacy-key');
  assert.equal(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).version, 1, 'not rewritten until a change');
  await store.update({ metadata: { provider: 'tmdb' } });
  const saved = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.version, 6);
  assert.deepEqual(saved.settings.metadata, { provider: 'tmdb', tmdbApiKey: '' });
  assert.deepEqual((await SettingsStore.open(dir, {})).snapshot(), store.snapshot());
});
