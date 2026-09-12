import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../../storage.js';
import { objectRecord } from '../../json.js';
import { coordinated, ConflictError } from '../../downloads/coordinator.js';
import {
  DownloadsStorageError, FILE, isRecord, migrateLegacyRecord, migrateOwnership, normalize,
  type DownloadRecord,
} from '../../downloads/store.js';

// Debridarr's record of the torrents it has added: identity, chosen file, and
// the retention fields (`kept`, `expiresAt`). The backend owns live progress and
// ratio. Same durability as the settings store: atomic writes, a serialized
// queue, and corrupt files are surfaced, never reset.
export class JsonDownloadsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private byHash = new Map<string, DownloadRecord>();

  private readonly path: string;
  private constructor(path: string, records: DownloadRecord[]) {
    this.path = path;
    for (const record of records) this.byHash.set(record.infoHash, record);
  }

  static async open(dataDir: string): Promise<JsonDownloadsStore> {
    const path = join(dataDir, FILE);
    let contents: string | undefined;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try { contents = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch {
      throw new DownloadsStorageError('Cannot read download storage. Check DATA_DIR and its permissions.');
    }
    if (contents === undefined) {
      const store = new JsonDownloadsStore(path, []);
      try { await atomicWriteJson(path, { version: 4, downloads: [] }); }
      catch { throw new DownloadsStorageError('Cannot initialize download storage. Check DATA_DIR and its permissions.'); }
      return store;
    }
    let records: DownloadRecord[];
    try {
      const document = objectRecord(JSON.parse(contents));
      if (!document) throw new Error('bad shape');
      const version = Number(document.version);
      if (![1, 2, 3, 4].includes(version) || !Array.isArray(document.downloads)) throw new Error('bad shape');
      const withMedia = version < 3 ? document.downloads.map(migrateLegacyRecord) : document.downloads;
      const raw = version < 4 ? withMedia.map(migrateOwnership) : withMedia;
      if (!raw.every(isRecord)) throw new Error('bad shape');
      records = (raw as DownloadRecord[]).map(normalize);
    } catch {
      throw new DownloadsStorageError('Saved downloads are invalid or unsupported. Restore downloads.json from a backup; it has not been reset.');
    }
    try { await chmod(path, 0o600); } catch { /* best effort */ }
    return new JsonDownloadsStore(path, records);
  }

  list(): DownloadRecord[] {
    return [...this.byHash.values()].map(normalize).sort((a, b) => b.addedAt - a.addedAt);
  }

  get(infoHash: string): DownloadRecord | undefined {
    const record = this.byHash.get(infoHash.toLowerCase());
    return record ? normalize(record) : undefined;
  }

  upsert(record: DownloadRecord): Promise<DownloadRecord> {
    const next = normalize(record);
    return this.write(map => map.set(next.infoHash, next)).then(() => next);
  }

  remove(infoHash: string): Promise<void> {
    return this.write(map => map.delete(infoHash.toLowerCase())).then(() => undefined);
  }

  setKept(infoHash: string, kept: boolean): Promise<DownloadRecord | undefined> {
    if (this.get(infoHash)?.lifecycle === 'deleting') return Promise.reject(new ConflictError('Deletion is already in progress.'));
    return coordinated(this, infoHash, async () => {
      if (this.get(infoHash)?.lifecycle === 'deleting') throw new ConflictError('Deletion is already in progress.');
      await this.write(map => {
        const current = map.get(infoHash.toLowerCase());
        if (current) map.set(current.infoHash, { ...current, kept });
      });
      return this.get(infoHash);
    });
  }

  // Resets the retention lease, e.g. on playback when extendOnPlay is enabled.
  renew(infoHash: string, expiresAt: number): Promise<DownloadRecord | undefined> {
    return this.write(map => {
      const current = map.get(infoHash.toLowerCase());
      if (current) map.set(current.infoHash, { ...current, expiresAt });
    }).then(() => this.get(infoHash));
  }

  private write(mutate: (map: Map<string, DownloadRecord>) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = new Map(this.byHash);
      mutate(next);
      try {
        await atomicWriteJson(this.path, { version: 4, downloads: [...next.values()] });
      } catch {
        throw new DownloadsStorageError('Downloads could not be saved. The previous record remains active.');
      }
      this.byHash = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
