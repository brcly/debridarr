import { timingSafeEqual } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../../storage.js';
import { objectRecord } from '../../json.js';
import { isPrepareTransferRequest, type PrepareTransferRequest } from '../../application/types.js';
import {
  MAX_REFERENCES, MAX_REFERENCE_BYTES, TTL, identifier, type Document,
} from '../../security/addon.js';

// Search playback references. A browsed release becomes an opaque, expiring
// `/play/<token>` handle that resolves to a backend-neutral prepare request; the
// source (magnet / download URL) is held here and never encoded in the token.
// Links to already-owned files use signed `/api/v1/download` tokens instead and
// do not touch this store.
export class JsonAddonAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private path: string;
  private state: Document;
  private constructor(path: string, state: Document) {
    this.path = path;
    this.state = state;
  }
  static async open(dataDir: string): Promise<JsonAddonAccess> {
    const path = join(dataDir, 'addon.json');
    let stored: unknown;
    try { stored = JSON.parse(await readFile(path, 'utf8')) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Addon access storage is invalid; restore addon.json.', { cause: error });
      stored = { version: 3, key: identifier(), references: [] };
      await atomicWriteJson(path, stored);
    }
    // Schema 1/2 references contain the deleted PlayTarget shape and cannot be
    // translated safely. Preserve the installation key and discard those
    // short-lived references; users only need to reopen a stream result.
    if (isLegacyDocument(stored)) {
      stored = { version: 3, key: stored.key, references: [] } satisfies Document;
      await atomicWriteJson(path, stored);
    }
    const state = stored as Document;
    if (!state || typeof state !== 'object' || state.version !== 3 || !/^[\w-]{43}$/.test(state.key)
      || !Array.isArray(state.references) || state.references.length > MAX_REFERENCES
      || state.references.some(r => !r || typeof r !== 'object' || !/^[\w-]{43}$/.test(r.id)
        || !Number.isFinite(r.created) || typeof r.source !== 'string' || !isPrepareTransferRequest(r.request)
        || Buffer.byteLength(JSON.stringify(r.request)) > MAX_REFERENCE_BYTES)) {
      throw new Error('Addon access storage is invalid; restore addon.json.');
    }
    await chmod(path, 0o600);
    return new JsonAddonAccess(path, state);
  }
  // Full document, including the raw addon key. Used only by the one-time
  // SQLite importer, never by application code.
  dump(): Document { return structuredClone(this.state); }

  valid(key: string): boolean {
    return /^[\w-]{43}$/.test(key) && timingSafeEqual(Buffer.from(key), Buffer.from(this.state.key));
  }
  base(appUrl: string): string { return `${appUrl}/addon/${this.state.key}`; }
  get(id: string, source: string, now = Date.now()): PrepareTransferRequest | undefined {
    const entry = this.state.references.find(r => r.id === id && r.source === source && r.created + TTL > now);
    return entry ? structuredClone(entry.request) : undefined;
  }
  async issue(requests: PrepareTransferRequest[], source: string, now = Date.now()): Promise<string[]> {
    const entries = requests.map(request => {
      if (!isPrepareTransferRequest(request)) throw new Error('Invalid release reference');
      if (Buffer.byteLength(JSON.stringify(request)) > MAX_REFERENCE_BYTES) throw new Error('Release reference too large');
      return { id: identifier(), created: now, source, request: structuredClone(request) };
    });
    await this.write(state => {
      const live = state.references.filter(r => r.created + TTL > now);
      // Newest wins under the shared cap; other sources are not evicted first.
      return { ...state, references: [...live.filter(r => r.source !== source), ...live.filter(r => r.source === source), ...entries].slice(-MAX_REFERENCES) };
    });
    return entries.map(r => r.id);
  }
  rotate(): Promise<void> { return this.write(() => ({ version: 3, key: identifier(), references: [] })); }
  invalidate(): Promise<void> { return this.write(state => ({ ...state, references: [] })); }
  async pruneExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    await this.write(state => {
      const live = state.references.filter(r => r.created + TTL > now);
      removed = state.references.length - live.length;
      return removed ? { ...state, references: live } : state;
    });
    return removed;
  }
  private write(update: (state: Document) => Document): Promise<void> {
    const op = this.queue.then(async () => {
      const next = update(this.state);
      await atomicWriteJson(this.path, next);
      this.state = next;
    });
    this.queue = op.catch(() => {});
    return op;
  }
}

function isLegacyDocument(value: unknown): value is { version: 1 | 2; key: string; references: unknown[] } {
  const document = objectRecord(value);
  if (!document) return false;
  if ((document.version !== 1 && document.version !== 2) || !/^[\w-]{43}$/.test(String(document.key))
    || !Array.isArray(document.references) || document.references.length > MAX_REFERENCES * 2) return false;
  return document.references.every(entry => {
    const reference = objectRecord(entry);
    if (!reference) return false;
    if (!/^[\w-]{43}$/.test(String(reference.id)) || !Number.isFinite(reference.created)
      || typeof reference.source !== 'string' || !reference.target || typeof reference.target !== 'object'
      || Buffer.byteLength(JSON.stringify(reference.target)) > MAX_REFERENCE_BYTES) return false;
    return document.version === 1 || reference.bucket === 'search' || reference.bucket === 'store';
  });
}
