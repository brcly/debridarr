import { coordinated, ConflictError } from './coordinator.js';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../storage.js';

export class DownloadsStorageError extends Error {}

export interface DownloadRecord {
  infoHash: string;
  name: string;
  imdbId: string;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
  fileIndex: number;
  fileName: string;
  bytes: number;
  addedAt: number;
  expiresAt: number;
  kept: boolean;
  lifecycle?: 'registering' | 'managed' | 'failed' | 'deleting' | 'conflict';
  owner?: { client: string; tag: string; category: string };
  selectedFiles?: { index: number; name: string; bytes: number }[];
  failure?: string;
}

const FILE = 'downloads.json';

function isRecord(value: unknown): value is DownloadRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return /^[a-f0-9]{40}$/.test(String(r.infoHash))
    && typeof r.name === 'string'
    && /^tt\d{1,10}$/.test(String(r.imdbId))
    && (r.type === 'movie' || r.type === 'series')
    && (r.season === undefined || (Number.isInteger(r.season) && (r.season as number) >= 0))
    && (r.episode === undefined || (Number.isInteger(r.episode) && (r.episode as number) >= 0))
    && Number.isInteger(r.fileIndex) && (r.fileIndex as number) >= 0
    && typeof r.fileName === 'string'
    && Number.isFinite(r.bytes) && (r.bytes as number) >= 0
    && Number.isFinite(r.addedAt) && Number.isFinite(r.expiresAt)
    && typeof r.kept === 'boolean'
    && (r.lifecycle === undefined || ['registering','managed','failed','deleting','conflict'].includes(String(r.lifecycle)))
    && (r.owner === undefined || (typeof r.owner === 'object' && r.owner !== null
      && typeof (r.owner as Record<string, unknown>).client === 'string'
      && typeof (r.owner as Record<string, unknown>).tag === 'string'
      && typeof (r.owner as Record<string, unknown>).category === 'string'))
    && (r.selectedFiles === undefined || (Array.isArray(r.selectedFiles) && r.selectedFiles.every(f => f && Number.isInteger(f.index) && f.index >= 0 && typeof f.name === 'string' && Number.isFinite(f.bytes) && f.bytes >= 0)))
    && (r.failure === undefined || typeof r.failure === 'string');
}

function normalize(record: DownloadRecord): DownloadRecord {
  return structuredClone({ ...record, infoHash: record.infoHash.toLowerCase() });
}

// Debridarr's record of the torrents it has added: identity, chosen file, and
// the retention fields (`kept`, `expiresAt`). qBittorrent owns live progress and
// ratio. Same durability as the settings store: atomic writes, a serialized
// queue, and corrupt files are surfaced, never reset.
export class DownloadsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private byHash = new Map<string, DownloadRecord>();

  private constructor(private readonly path: string, records: DownloadRecord[]) {
    for (const record of records) this.byHash.set(record.infoHash, record);
  }

  static async open(dataDir: string): Promise<DownloadsStore> {
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
      const store = new DownloadsStore(path, []);
      try { await atomicWriteJson(path, { version: 2, downloads: [] }); }
      catch { throw new DownloadsStorageError('Cannot initialize download storage. Check DATA_DIR and its permissions.'); }
      return store;
    }
    let records: DownloadRecord[];
    try {
      const document = JSON.parse(contents) as Record<string, unknown>;
      if (!document || ![1, 2].includes(Number(document.version)) || !Array.isArray(document.downloads) || !document.downloads.every(isRecord)) {
        throw new Error('bad shape');
      }
      records = (document.downloads as DownloadRecord[]).map(normalize);
    } catch {
      throw new DownloadsStorageError('Saved downloads are invalid or unsupported. Restore downloads.json from a backup; it has not been reset.');
    }
    try { await chmod(path, 0o600); } catch { /* best effort */ }
    return new DownloadsStore(path, records);
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
        await atomicWriteJson(this.path, { version: 2, downloads: [...next.values()] });
      } catch {
        throw new DownloadsStorageError('Downloads could not be saved. The previous record remains active.');
      }
      this.byHash = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
