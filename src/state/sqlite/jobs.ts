import type { DatabaseSync } from 'node:sqlite';
import type { JobRecord, JobsRepository } from '../repositories.js';

interface Row {
  id: string; kind: string; payload: string | null; attempts: number;
  next_run_at: number; lease_until: number | null; lease_id: string | null; last_error: string | null;
}

const toRecord = (row: Row): JobRecord => ({
  id: row.id, kind: row.kind, payload: row.payload, attempts: row.attempts,
  nextRunAt: row.next_run_at, leaseUntil: row.lease_until, leaseId: row.lease_id, lastError: row.last_error,
});

const COLUMNS = 'id, kind, payload, attempts, next_run_at, lease_until, lease_id, last_error';

// Durable job intent: a scheduled sweep, recovery pass, or deletion retry
// survives a crash or restart at its persisted `next_run_at`, and the lease
// columns stop a job claimed just before a crash from being silently lost
// (it becomes claimable again once its lease expires) or double-run.
export class SqliteJobsStore implements JobsRepository {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): JobRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM jobs`).all() as unknown as Row[];
    return rows.map(toRecord);
  }

  async ensure(id: string, kind: string, nextRunAt: number, payload: string | null = null): Promise<void> {
    this.db.prepare(
      `INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL) ON CONFLICT(id) DO NOTHING`,
    ).run(id, kind, payload, nextRunAt);
  }

  async claimDue(now: number, leaseMs: number, leaseId: string): Promise<JobRecord | undefined> {
    const row = this.db.prepare(
      `SELECT ${COLUMNS} FROM jobs WHERE next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_run_at ASC LIMIT 1`,
    ).get(now, now) as unknown as Row | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE jobs SET lease_until = ?, lease_id = ? WHERE id = ?').run(now + leaseMs, leaseId, row.id);
    return { ...toRecord(row), leaseUntil: now + leaseMs, leaseId };
  }

  async reschedule(id: string, nextRunAt: number, attempts: number, lastError: string | null): Promise<void> {
    this.db.prepare('UPDATE jobs SET next_run_at = ?, attempts = ?, lease_until = NULL, lease_id = NULL, last_error = ? WHERE id = ?')
      .run(nextRunAt, attempts, lastError, id);
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
}
