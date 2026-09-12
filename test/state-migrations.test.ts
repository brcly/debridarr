import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  BASELINE_VERSION, SchemaVersionError, latestSchemaVersion, migrate, migrations,
  readSchemaVersion, setMeta, type Migration,
} from '../src/state/sqlite/migrations.js';
import { getMeta, openDatabase } from '../src/state/sqlite/db.js';
import { importState } from '../src/state/importer.js';
import { SqliteDownloadsStore } from '../src/state/sqlite/downloads.js';
import { tmpDir } from './helpers.js';

async function dir(t: TestContext): Promise<string> {
  const path = await tmpDir(t, 'debridarr-migrate');
  return path;
}

function memory(t: TestContext): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

const addColumn: Migration = {
  version: 2,
  description: 'test: add downloads.note',
  up: db => { db.exec('ALTER TABLE downloads ADD COLUMN note TEXT'); },
};

const addTable: Migration = {
  version: 3,
  description: 'test: add notes table',
  up: db => { db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY)'); },
};

test('a fresh database is created at the baseline and reports it', t => {
  const db = memory(t);
  assert.equal(migrate(db, []), BASELINE_VERSION);
  assert.equal(readSchemaVersion(db), BASELINE_VERSION);
  // The baseline must actually be the shape the repositories expect.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  assert.deepEqual(tables.map(row => row.name).filter(name => !name.startsWith('sqlite_')),
    ['addon_references', 'downloads', 'idempotency', 'jobs', 'meta', 'secrets', 'settings', 'tokens']);
});

test('migrate is idempotent: a second run applies nothing', t => {
  const db = memory(t);
  migrate(db, [addColumn]);
  assert.equal(migrate(db, [addColumn]), 2);
  assert.equal(readSchemaVersion(db), 2);
});

test('a v1 database gains later steps without losing its rows', t => {
  const db = memory(t);

  // Build a database exactly as 0.1.x left it: baseline shape, version 1.
  migrate(db, []);
  db.prepare('INSERT INTO downloads (info_hash, kept, expires_at, lifecycle, record) VALUES (?, 1, 99, ?, ?)')
    .run('a'.repeat(40), 'managed', JSON.stringify({ name: 'Movie' }));
  assert.equal(readSchemaVersion(db), 1);

  assert.equal(migrate(db, [addColumn, addTable]), 3);

  const row = db.prepare('SELECT info_hash, kept, note FROM downloads').get() as
    { info_hash: string; kept: number; note: string | null };
  assert.equal(row.info_hash, 'a'.repeat(40));
  assert.equal(row.kept, 1);
  assert.equal(row.note, null, 'the added column defaults to null for existing rows');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'notes'").get());
});

test('steps are applied in ascending order regardless of array order', t => {
  const db = memory(t);
  const order: number[] = [];
  const step = (version: number): Migration => ({
    version, description: `test ${version}`, up: () => { order.push(version); },
  });
  migrate(db, [step(4), step(2), step(3)]);
  assert.deepEqual(order, [2, 3, 4]);
  assert.equal(readSchemaVersion(db), 4);
});

test('a database from a newer build is refused, not silently used', t => {
  const db = memory(t);
  migrate(db, [addColumn, addTable]);

  assert.throws(() => migrate(db, [addColumn]), (error: Error) => {
    assert.ok(error instanceof SchemaVersionError);
    assert.match(error.message, /schema version 3/);
    assert.match(error.message, /only understands 2/);
    assert.match(error.message, /newer Debridarr/);
    return true;
  });
});

test('a failed step rolls back and leaves the previous version in place', t => {
  const db = memory(t);
  migrate(db, []);

  const broken: Migration = {
    version: 2,
    description: 'test: fails halfway',
    up: db2 => {
      db2.exec('CREATE TABLE half_applied (id TEXT)');
      throw new Error('boom');
    },
  };

  assert.throws(() => migrate(db, [broken]), (error: Error) => {
    assert.ok(error instanceof SchemaVersionError);
    assert.match(error.message, /migration 2 \(test: fails halfway\) failed/);
    return true;
  });

  assert.equal(readSchemaVersion(db), 1, 'version must not advance past a failed step');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_applied'").get(), undefined,
    'the partial DDL must have been rolled back');

  // And the upgrade can be retried once the step is fixed.
  assert.equal(migrate(db, [addColumn]), 2);
});

test('an unreadable schema version is refused rather than guessed', t => {
  const db = memory(t);
  migrate(db, []);
  setMeta(db, 'schema_version', 'banana');
  assert.throws(() => readSchemaVersion(db), SchemaVersionError);
  assert.throws(() => migrate(db, []), /unreadable schema version/);
});

test('latestSchemaVersion reflects the shipped migration list', () => {
  assert.equal(latestSchemaVersion([]), BASELINE_VERSION);
  assert.equal(latestSchemaVersion([addColumn, addTable]), 3);
  // Guards against a step being added without the baseline staying frozen.
  assert.ok(latestSchemaVersion(migrations) >= BASELINE_VERSION);
  for (const step of migrations) assert.ok(step.version > BASELINE_VERSION, 'steps must be above the baseline');
});

test('openDatabase migrates on open, and a real 0.1.x directory still imports', async t => {
  const dataDir = await dir(t);

  // First open: creates and versions the schema.
  const first = openDatabase(dataDir);
  assert.equal((first.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum, 2);
  assert.equal(getMeta(first, 'schema_version'), String(BASELINE_VERSION));
  assert.equal(getMeta(first, 'instance_id'), undefined, 'schema alone must not mark state as established');

  await importState(dataDir, {}, first);
  const instanceId = getMeta(first, 'instance_id');
  assert.ok(instanceId);

  await new SqliteDownloadsStore(first).upsert({
    origin: 'search', infoHash: 'c'.repeat(40), name: 'Kept', media: { imdbId: 'tt1', type: 'movie' },
    fileIndex: 0, fileName: 'a.mkv', bytes: 1, addedAt: 1, expiresAt: 2, kept: true,
  });
  first.close();

  // Reopening must not re-run the import or re-stamp the instance.
  const second = openDatabase(dataDir);
  t.after(() => { try { second.close(); } catch { /* already closed */ } });
  await importState(dataDir, {}, second);
  assert.equal(getMeta(second, 'instance_id'), instanceId);
  assert.equal(new SqliteDownloadsStore(second).get('c'.repeat(40))?.name, 'Kept');
});
