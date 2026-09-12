import type { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { isPrepareTransferRequest, type PrepareTransferRequest } from '../../application/types.js';
import { MAX_REFERENCES, MAX_REFERENCE_BYTES, TTL, identifier, type Reference } from '../../security/addon.js';
import { ensureSecretsRow } from './db.js';

interface Row { record: string }

export class SqliteAddonAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private key: string;

  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync, key: string) {
    this.db = db;
    this.key = key;
  }

  static open(db: DatabaseSync): SqliteAddonAccess {
    const { addonKey } = ensureSecretsRow(db);
    return new SqliteAddonAccess(db, addonKey);
  }

  private references(now: number): Reference[] {
    const rows = this.db.prepare('SELECT record FROM addon_references WHERE expires_at > ?').all(now) as unknown as Row[];
    return rows.map(row => JSON.parse(row.record) as Reference);
  }

  valid(key: string): boolean {
    return /^[\w-]{43}$/.test(key) && timingSafeEqual(Buffer.from(key), Buffer.from(this.key));
  }

  base(appUrl: string): string { return `${appUrl}/addon/${this.key}`; }

  get(id: string, source: string, now = Date.now()): PrepareTransferRequest | undefined {
    const row = this.db.prepare('SELECT record FROM addon_references WHERE id = ? AND expires_at > ?').get(id, now) as Row | undefined;
    if (!row) return undefined;
    const reference = JSON.parse(row.record) as Reference;
    return reference.source === source ? structuredClone(reference.request) : undefined;
  }

  async issue(requests: PrepareTransferRequest[], source: string, now = Date.now()): Promise<string[]> {
    const entries: Reference[] = requests.map(request => {
      if (!isPrepareTransferRequest(request)) throw new Error('Invalid release reference');
      if (Buffer.byteLength(JSON.stringify(request)) > MAX_REFERENCE_BYTES) throw new Error('Release reference too large');
      return { id: identifier(), created: now, source, request: structuredClone(request) };
    });
    await this.write(() => {
      const live = this.references(now);
      // Newest wins under the shared cap; other sources are not evicted first.
      const kept = [...live.filter(r => r.source !== source), ...live.filter(r => r.source === source), ...entries].slice(-MAX_REFERENCES);
      this.db.exec('BEGIN');
      try {
        this.db.exec('DELETE FROM addon_references');
        const insert = this.db.prepare('INSERT INTO addon_references (id, record, expires_at) VALUES (?, ?, ?)');
        for (const reference of kept) insert.run(reference.id, JSON.stringify(reference), reference.created + TTL);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    return entries.map(r => r.id);
  }

  rotate(): Promise<void> {
    return this.write(() => {
      const next = identifier();
      this.db.prepare('UPDATE secrets SET addon_key = ? WHERE id = 1').run(next);
      this.db.exec('DELETE FROM addon_references');
      this.key = next;
    });
  }

  invalidate(): Promise<void> {
    return this.write(() => { this.db.exec('DELETE FROM addon_references'); });
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    await this.write(() => {
      removed = Number(this.db.prepare('DELETE FROM addon_references WHERE expires_at <= ?').run(now).changes);
    });
    return removed;
  }

  private write(mutate: () => void): Promise<void> {
    const operation = this.queue.then(async () => { mutate(); });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
