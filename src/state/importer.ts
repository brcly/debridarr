import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { currentSettingsVersion } from '../settings.js';
import { TTL } from '../security/addon.js';
import { JsonSettingsStore } from './json/settings.js';
import { JsonDownloadsStore } from './json/downloads.js';
import { JsonStoreAccess } from './json/access.js';
import { JsonAddonAccess } from './json/addon.js';
import { getMeta, setMeta, writeSecretsRow } from './sqlite/db.js';

export class ImportError extends Error {}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

// Runs once, before the HTTP server starts listening. A fresh install (no
// prior JSON files) just marks the SQLite schema initialized; the repository
// constructors seed their own defaults on first open. An existing JSON
// install is fully read and validated through the unchanged JSON migration
// logic, then committed into SQLite in one transaction, and only then are the
// original files moved aside — so a failure at any point leaves the JSON
// files as the sole, untouched source of truth.
export async function importState(dataDir: string, env: NodeJS.ProcessEnv, db: DatabaseSync): Promise<void> {
  // instance_id, not schema_version: the schema is created and versioned by
  // the migration runner at open time, so it is always set by now. instance_id
  // is written only by the two branches below, and so is the one marker that
  // means "state has already been established in this database".
  if (getMeta(db, 'instance_id')) return;

  const hadJson = await pathExists(join(dataDir, 'settings.json'));
  if (!hadJson) {
    setMeta(db, 'instance_id', randomUUID());
    return;
  }

  const settingsStore = await JsonSettingsStore.open(dataDir, env);
  const downloadsStore = await JsonDownloadsStore.open(dataDir);
  const accessStore = await JsonStoreAccess.open(dataDir);
  const addonStore = await JsonAddonAccess.open(dataDir);

  const settings = settingsStore.snapshot();
  const downloads = downloadsStore.list();
  const accessDump = accessStore.dump();
  const addonDump = addonStore.dump();

  try {
    db.exec('BEGIN');
    db.prepare(
      'INSERT INTO settings (id, version, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data',
    ).run(currentSettingsVersion, JSON.stringify(settings));

    const insertDownload = db.prepare(
      `INSERT INTO downloads (info_hash, kept, expires_at, lifecycle, record) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(info_hash) DO UPDATE SET kept = excluded.kept, expires_at = excluded.expires_at, lifecycle = excluded.lifecycle, record = excluded.record`,
    );
    for (const record of downloads) {
      insertDownload.run(record.infoHash, record.kept ? 1 : 0, record.expiresAt, record.lifecycle ?? null, JSON.stringify(record));
    }

    const insertToken = db.prepare('INSERT INTO tokens (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record');
    for (const token of accessDump.tokens) insertToken.run(token.id, JSON.stringify(token));

    writeSecretsRow(db, accessDump.linkSecret, addonDump.key);

    const insertReference = db.prepare(
      'INSERT INTO addon_references (id, record, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record, expires_at = excluded.expires_at',
    );
    for (const reference of addonDump.references) insertReference.run(reference.id, JSON.stringify(reference), reference.created + TTL);

    setMeta(db, 'instance_id', randomUUID());
    setMeta(db, 'imported_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    throw new ImportError('Imported state could not be written to the database. The original JSON files are untouched; restore from them if this repeats.');
  }

  const stamp = new Date().toISOString().replace(/:/g, '-');
  const backupDir = join(dataDir, `backup-${stamp}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  for (const file of ['settings.json', 'downloads.json', 'store.json', 'addon.json']) {
    const source = join(dataDir, file);
    if (await pathExists(source)) await rename(source, join(backupDir, file));
  }
}
