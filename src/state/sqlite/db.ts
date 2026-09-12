import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


export class SqliteStorageError extends Error {}

// A single SQLite connection, shared by the four repositories and the
// one-time importer. WAL plus synchronous=FULL keeps writes crash-safe
// without serializing every read behind every writer.
export function maintainDatabase(db: DatabaseSync): void {
  try { db.exec('PRAGMA optimize'); } catch { /* best effort */ }
  // auto_vacuum=INCREMENTAL makes deleted pages reclaimable without a long,
  // blocking full VACUUM during each hourly retention sweep.
  try { db.exec('PRAGMA incremental_vacuum(1000)'); } catch { /* best effort */ }
}

export function closeDatabase(db: DatabaseSync): void {
  maintainDatabase(db);
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  try { db.close(); } catch { /* already closed */ }
}

export function openDatabase(dataDir: string): DatabaseSync {
  const path = join(dataDir, 'debridarr.db');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    throw new SqliteStorageError('Cannot open state database. Check DATA_DIR and its permissions.');
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const vacuum = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
  if (vacuum.auto_vacuum !== 2) {
    // Changing an existing database's pointer-map layout requires one full
    // rewrite. The persisted pragma means this only happens once.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
  }
  return db;
}

export async function prepareDataDir(dataDir: string): Promise<void> {
  try { await mkdir(dataDir, { recursive: true, mode: 0o700 }); }
  catch { throw new SqliteStorageError('Cannot create DATA_DIR. Check its permissions.'); }
}

export async function protectDatabaseFile(dataDir: string): Promise<void> {
  const path = join(dataDir, 'debridarr.db');
  try { await chmod(path, 0o600); } catch { /* best effort */ }
}

export { getMeta, setMeta, migrate, readSchemaVersion, latestSchemaVersion, SchemaVersionError } from './migrations.js';

// The link-signing secret and the search addon key are irreversible roots:
// losing either invalidates every signed download link or addon install. They
// share one row so a fresh install always mints both together, and either
// repository can call this idempotently to read (or seed) the pair.
export function ensureSecretsRow(db: DatabaseSync): { linkSecret: string; addonKey: string } {
  const existing = db.prepare('SELECT link_secret, addon_key FROM secrets WHERE id = 1').get() as
    { link_secret: string; addon_key: string } | undefined;
  if (existing) return { linkSecret: existing.link_secret, addonKey: existing.addon_key };
  const linkSecret = randomBytes(32).toString('base64url');
  const addonKey = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO secrets (id, link_secret, addon_key) VALUES (1, ?, ?)').run(linkSecret, addonKey);
  return { linkSecret, addonKey };
}

// Used only by the one-time importer, which must preserve imported secrets
// exactly rather than generating fresh ones.
export function writeSecretsRow(db: DatabaseSync, linkSecret: string, addonKey: string): void {
  db.prepare(
    'INSERT INTO secrets (id, link_secret, addon_key) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET link_secret = excluded.link_secret, addon_key = excluded.addon_key',
  ).run(linkSecret, addonKey);
}
