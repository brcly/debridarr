import type { IdempotencyEntry, IdempotencyRepository } from '../repositories.js';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { objectRecord } from '../../json.js';
import { atomicWriteJson } from '../../storage.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Row { at: number; entry: IdempotencyEntry }
interface Document { version: 1; entries: [string, Row][] }

export class JsonIdempotencyStore implements IdempotencyRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly rows = new Map<string, Row>();
  private readonly path: string | undefined;

  constructor(path?: string, rows: [string, Row][] = []) {
    this.path = path;
    for (const [id, row] of rows) this.rows.set(id, row);
  }

  static async open(dataDir: string): Promise<JsonIdempotencyStore> {
    const path = join(dataDir, 'idempotency.json');
    let contents: string | undefined;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try { contents = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch { throw new Error('Cannot read idempotency storage. Check DATA_DIR and its permissions.'); }
    if (contents === undefined) {
      const store = new JsonIdempotencyStore(path);
      await store.persist();
      return store;
    }
    let entries: [string, Row][];
    try {
      const document = objectRecord(JSON.parse(contents));
      if (!document || document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES) throw new Error();
      entries = document.entries.map(value => {
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || value[0].length > 512) throw new Error();
        const row = objectRecord(value[1]);
        const entry = objectRecord(row?.entry);
        const status = entry?.status;
        if (!row || !Number.isFinite(row.at) || !entry || !Number.isInteger(status) || (status as number) < 100 || (status as number) > 599 || !Object.hasOwn(entry, 'body')) throw new Error();
        return [value[0], { at: row.at as number, entry: { status: status as number, body: entry.body } }];
      });
    } catch { throw new Error('Idempotency storage is invalid; restore idempotency.json.'); }
    try { await chmod(path, 0o600); } catch { /* best effort */ }
    return new JsonIdempotencyStore(path, entries);
  }

  get(id: string, now: number): IdempotencyEntry | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    if (now - row.at > TTL_MS) { this.rows.delete(id); return undefined; }
    return structuredClone(row.entry);
  }

  put(id: string, entry: IdempotencyEntry, now: number): Promise<void> {
    return this.write(rows => {
      for (const [candidate, row] of rows) if (now - row.at > TTL_MS) rows.delete(candidate);
      if (rows.size >= MAX_ENTRIES && !rows.has(id)) rows.delete(rows.keys().next().value!);
      rows.set(id, { at: now, entry: structuredClone(entry) });
    });
  }

  private write(mutate: (rows: Map<string, Row>) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = new Map(this.rows);
      mutate(next);
      if (this.path) await atomicWriteJson(this.path, { version: 1, entries: [...next] } satisfies Document);
      this.rows.clear();
      for (const [id, row] of next) this.rows.set(id, row);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private persist(): Promise<void> {
    return this.path ? atomicWriteJson(this.path, { version: 1, entries: [] } satisfies Document) : Promise.resolve();
  }
}
