import type { DatabaseSync } from 'node:sqlite';
import { coordinated, ConflictError } from '../../downloads/coordinator.js';
import { DownloadsStorageError, normalize, type DownloadRecord } from '../../downloads/store.js';

interface Row { record: string }

export class SqliteDownloadsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private byHash: Map<string, DownloadRecord> | undefined;
  private sorted: DownloadRecord[] | undefined;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // Hydrate once; subsequent list/get hit memory. Writes update the map after
  // a successful SQLite statement so the dashboard poll does not re-parse every row.
  private load(): Map<string, DownloadRecord> {
    if (this.byHash) return this.byHash;
    const rows = this.db.prepare('SELECT record FROM downloads').all() as unknown as Row[];
    this.byHash = new Map();
    for (const row of rows) {
      const record = normalize(JSON.parse(row.record) as DownloadRecord);
      this.byHash.set(record.infoHash, record);
    }
    return this.byHash;
  }

  // Re-sorting on every call showed up on the dashboard poll and every
  // /health/ready hit; cache the sorted view and only rebuild it after a write.
  list(): DownloadRecord[] {
    this.load();
    if (!this.sorted) this.sorted = [...this.byHash!.values()].sort((a, b) => b.addedAt - a.addedAt);
    return this.sorted.map(normalize);
  }

  get(infoHash: string): DownloadRecord | undefined {
    const record = this.load().get(infoHash.toLowerCase());
    return record ? normalize(record) : undefined;
  }

  upsert(record: DownloadRecord): Promise<DownloadRecord> {
    const next = normalize(record);
    return this.persist(next).then(() => next);
  }

  remove(infoHash: string): Promise<void> {
    return this.run(() => {
      const hash = infoHash.toLowerCase();
      this.db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(hash);
      this.load().delete(hash);
      this.sorted = undefined;
    });
  }

  setKept(infoHash: string, kept: boolean): Promise<DownloadRecord | undefined> {
    if (this.get(infoHash)?.lifecycle === 'deleting') return Promise.reject(new ConflictError('Deletion is already in progress.'));
    return coordinated(this, infoHash, async () => {
      if (this.get(infoHash)?.lifecycle === 'deleting') throw new ConflictError('Deletion is already in progress.');
      const current = this.get(infoHash);
      if (current) await this.persist({ ...current, kept });
      return this.get(infoHash);
    });
  }

  // Resets the retention lease, e.g. on playback when extendOnPlay is enabled.
  renew(infoHash: string, expiresAt: number): Promise<DownloadRecord | undefined> {
    return this.run(() => {
      const current = this.get(infoHash);
      if (current) this.write({ ...current, expiresAt });
    }).then(() => this.get(infoHash));
  }

  private persist(record: DownloadRecord): Promise<void> {
    return this.run(() => this.write(record));
  }

  private write(record: DownloadRecord): void {
    const next = normalize(record);
    this.db.prepare(
      `INSERT INTO downloads (info_hash, kept, expires_at, lifecycle, record)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(info_hash) DO UPDATE SET kept = excluded.kept, expires_at = excluded.expires_at, lifecycle = excluded.lifecycle, record = excluded.record`,
    ).run(next.infoHash, next.kept ? 1 : 0, next.expiresAt, next.lifecycle ?? null, JSON.stringify(next));
    this.load().set(next.infoHash, next);
    this.sorted = undefined;
  }

  private run(mutate: () => void): Promise<void> {
    const operation = this.queue.then(async () => {
      try { mutate(); }
      catch { throw new DownloadsStorageError('Downloads could not be saved. The previous record remains active.'); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
