import type { DatabaseSync } from 'node:sqlite';

// Schema evolution.
//
// BASELINE is frozen: it is the shape 0.1.x shipped and must never change
// again. Every later change is an entry in `migrations`, applied in order.
// A fresh database therefore takes exactly the same path as an upgrade
// (baseline, then every step), so the upgrade path is exercised on every
// single install rather than only on the machines that happen to have old
// data. Each step runs in its own transaction and bumps meta.schema_version,
// so an interrupted upgrade resumes at the step that failed.
//
// Rules for adding a step:
//   - never edit a released step, add a new one;
//   - `up` must be idempotent where SQLite allows it (IF NOT EXISTS);
//   - SQLite cannot drop or retype a column: rebuild the table instead.

export const BASELINE_VERSION = 1;

const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const BASELINE = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS downloads (
  info_hash TEXT PRIMARY KEY,
  kept INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lifecycle TEXT,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS downloads_expires_at_idx ON downloads (expires_at);
CREATE INDEX IF NOT EXISTS downloads_kept_idx ON downloads (kept);
CREATE INDEX IF NOT EXISTS downloads_lifecycle_idx ON downloads (lifecycle);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  link_secret TEXT NOT NULL,
  addon_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addon_references (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS addon_references_expires_at_idx ON addon_references (expires_at);
CREATE TABLE IF NOT EXISTS idempotency (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_at_idx ON idempotency (at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT,
  attempts INTEGER NOT NULL,
  next_run_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_id TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_next_run_at_idx ON jobs (next_run_at);
`;

export interface Migration {
  readonly version: number;
  readonly description: string;
  up(db: DatabaseSync): void;
}

// Steps beyond the baseline, ascending. Empty until the schema next changes.
export const migrations: readonly Migration[] = [];

export function latestSchemaVersion(steps: readonly Migration[] = migrations): number {
  return steps.reduce((highest, step) => Math.max(highest, step.version), BASELINE_VERSION);
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export class SchemaVersionError extends Error {}

// Absent means the database predates any schema at all (a fresh file). A
// value that is not a positive integer means the row was corrupted or hand
// edited; refusing is safer than guessing which migrations already ran.
export function readSchemaVersion(db: DatabaseSync): number | undefined {
  const raw = getMeta(db, 'schema_version');
  if (raw === undefined) return undefined;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new SchemaVersionError(`State database reports an unreadable schema version ${JSON.stringify(raw)}. Restore the data directory from a backup.`);
  }
  return version;
}

export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations): number {
  db.exec(META_TABLE);

  const latest = latestSchemaVersion(steps);
  let current = readSchemaVersion(db);

  if (current === undefined) {
    db.exec('BEGIN');
    try {
      db.exec(BASELINE);
      setMeta(db, 'schema_version', String(BASELINE_VERSION));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new SchemaVersionError('Could not create the state database schema.', { cause: error });
    }
    current = BASELINE_VERSION;
  }

  // A database written by a newer build may have columns and constraints this
  // build does not know about. Running against it would silently corrupt data,
  // so stop with a message that names the build the operator needs.
  if (current > latest) {
    throw new SchemaVersionError(
      `State database is at schema version ${current}, but this build only understands ${latest}. `
      + 'It was written by a newer Debridarr; upgrade to that version, or restore a backup taken before the upgrade.',
    );
  }

  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (step.version <= current) continue;
    db.exec('BEGIN');
    try {
      step.up(db);
      setMeta(db, 'schema_version', String(step.version));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new SchemaVersionError(
        `Schema migration ${step.version} (${step.description}) failed; the database is still at version ${current}.`,
        { cause: error },
      );
    }
    current = step.version;
  }

  return current;
}
