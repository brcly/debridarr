import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getMeta, openDatabase } from '../src/state/sqlite/db.js';
import { BASELINE_VERSION } from '../src/state/sqlite/migrations.js';
import { importState, ImportError } from '../src/state/importer.js';
import { JsonSettingsStore } from '../src/state/json/settings.js';
import { JsonDownloadsStore } from '../src/state/json/downloads.js';
import { JsonStoreAccess } from '../src/state/json/access.js';
import { JsonAddonAccess } from '../src/state/json/addon.js';
import { SqliteSettingsStore } from '../src/state/sqlite/settings.js';
import { SqliteDownloadsStore } from '../src/state/sqlite/downloads.js';
import { SqliteStoreAccess } from '../src/state/sqlite/access.js';
import { SqliteAddonAccess } from '../src/state/sqlite/addon.js';
import { tmpDir } from './helpers.js';

async function dir(t: TestContext): Promise<string> {
  const path = await tmpDir(t, 'debridarr-import');
  return path;
}

test('fresh install: no JSON files, importState only stamps meta', async t => {
  const dataDir = await dir(t);
  const db = openDatabase(dataDir);
  await importState(dataDir, {}, db);
  assert.equal(getMeta(db, 'schema_version'), String(BASELINE_VERSION));
  assert.ok(getMeta(db, 'instance_id'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get()?.n ?? 0, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()?.n ?? 0, 0);
});

test('existing JSON install: full round trip including secrets', async t => {
  const dataDir = await dir(t);

  const settingsStore = await JsonSettingsStore.open(dataDir, {});
  await settingsStore.update({ discovery: { providers: [{ type: 'prowlarr', url: 'http://prowlarr.test', apiKey: 'source-key' }] } });
  const downloadsStore = await JsonDownloadsStore.open(dataDir);
  await downloadsStore.upsert({
    origin: 'search', infoHash: 'a'.repeat(40), name: 'Movie', media: { imdbId: 'tt0133093', type: 'movie' },
    fileIndex: 0, fileName: 'movie.mkv', bytes: 100, addedAt: 1, expiresAt: 2, kept: false,
  });
  const accessStore = await JsonStoreAccess.open(dataDir);
  const { item } = await accessStore.create({ name: 'CLI' });
  const addonStore = await JsonAddonAccess.open(dataDir);
  await addonStore.issue([{ source: { infoHash: 'b'.repeat(40) }, origin: 'search', name: 'Movie', bytes: 100 }], 'browse');

  const expectedLinkSecret = accessStore.linkSecret();
  const expectedAddonKey = addonStore.base('https://x').split('/addon/')[1]!;

  const db = openDatabase(dataDir);
  await importState(dataDir, {}, db);

  assert.equal(getMeta(db, 'schema_version'), String(BASELINE_VERSION));
  assert.ok(getMeta(db, 'imported_at'));

  const settings = SqliteSettingsStore.open(db, {});
  assert.equal(settings.snapshot().discovery.providers[0]!.apiKey, 'source-key');

  const downloads = new SqliteDownloadsStore(db);
  assert.equal(downloads.get('a'.repeat(40))?.name, 'Movie');

  const storeAccess = SqliteStoreAccess.open(db);
  assert.deepEqual(storeAccess.linkSecret(), expectedLinkSecret);
  assert.equal(storeAccess.list()[0]?.id, item.id);

  const addonAccess = SqliteAddonAccess.open(db);
  assert.equal(addonAccess.valid(expectedAddonKey), true);

  const entries = await readdir(dataDir);
  const backupDir = entries.find(name => name.startsWith('backup-'));
  assert.ok(backupDir, 'backup directory should exist');
  const backedUp = await readdir(join(dataDir, backupDir!));
  assert.deepEqual(backedUp.sort(), ['addon.json', 'downloads.json', 'settings.json', 'store.json']);
  assert.ok(!entries.includes('settings.json'), 'original settings.json should have been moved');
});

test('corrupted JSON: import fails closed with no partial writes', async t => {
  const dataDir = await dir(t);
  await writeFile(join(dataDir, 'settings.json'), 'not json', 'utf8');

  const db = openDatabase(dataDir);
  await assert.rejects(importState(dataDir, {}, db));

  assert.equal(getMeta(db, 'instance_id'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get()?.n ?? 0, 0);
  const entries = await readdir(dataDir);
  assert.ok(entries.includes('settings.json'));
  assert.ok(!entries.some(name => name.startsWith('backup-')));
});

test('idempotent: a second importState call is a no-op', async t => {
  const dataDir = await dir(t);
  const db = openDatabase(dataDir);
  await importState(dataDir, {}, db);
  const instanceId = getMeta(db, 'instance_id');
  await importState(dataDir, {}, db);
  assert.equal(getMeta(db, 'instance_id'), instanceId);
});

test('ImportError is exported for callers that need to recognize a failed import', () => {
  assert.ok(new ImportError('x') instanceof Error);
});
