import type { DatabaseSync } from 'node:sqlite';
import type { IdempotencyEntry, IdempotencyRepository } from '../repositories.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Row { at: number; status: number; body: string }

// Durable replay for `POST /api/v1/transfers`: a restart no longer forgets an
// in-flight Idempotency-Key, so a client retry after a crash gets the
// original response instead of a second submission.
export class SqliteIdempotencyStore implements IdempotencyRepository {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(id: string, now: number): IdempotencyEntry | undefined {
    const row = this.db.prepare('SELECT at, status, body FROM idempotency WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!row) return undefined;
    if (now - row.at > TTL_MS) { this.db.prepare('DELETE FROM idempotency WHERE id = ?').run(id); return undefined; }
    return { status: row.status, body: JSON.parse(row.body) as unknown };
  }

  async put(id: string, entry: IdempotencyEntry, now: number): Promise<void> {
    this.db.prepare('DELETE FROM idempotency WHERE at < ?').run(now - TTL_MS);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get() as unknown as { n: number };
    if (n >= MAX_ENTRIES) {
      const oldest = this.db.prepare('SELECT id FROM idempotency ORDER BY at ASC LIMIT 1').get() as unknown as { id: string } | undefined;
      if (oldest && oldest.id !== id) this.db.prepare('DELETE FROM idempotency WHERE id = ?').run(oldest.id);
    }
    this.db.prepare(
      'INSERT INTO idempotency (id, at, status, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, status = excluded.status, body = excluded.body',
    ).run(id, now, entry.status, JSON.stringify(entry.body));
  }
}
