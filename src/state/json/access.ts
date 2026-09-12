import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../../storage.js';
import { objectRecord } from '../../json.js';
import { BusyError } from '../../security/admission.js';
import {
  digest, MAX_TOKENS, StoreAuthThrottle, tokenOptions, tokenScopes,
  type Document, type SavedToken, type StoreToken,
} from '../../store/access.js';

export class JsonStoreAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private failures = new Map<string, { count: number; until: number }>();
  private usage = new Map<string, { starts: number[]; active: number }>();
  private path: string;
  private state: Document;
  private constructor(path: string, state: Document) {
    this.path = path;
    this.state = state;
  }
  static async open(dataDir: string): Promise<JsonStoreAccess> {
    const path = join(dataDir, 'store.json');
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Store access storage is invalid; restore store.json.', { cause: error });
      const seeded: Document = { version: 2, tokens: [], linkSecret: randomBytes(32).toString('base64url') };
      await atomicWriteJson(path, seeded);
      await chmod(path, 0o600);
      return new JsonStoreAccess(path, seeded);
    }
    let state: Document;
    let rewrite = false;
    try {
      const doc = objectRecord(parsed);
      if (!doc) throw new Error();
      // Schema 1 had no per-token scopes and no link-signing secret. Grant every
      // legacy token full access, mint a secret, and persist the upgrade once.
      if (doc.version === 1) {
        if (Object.keys(doc).sort().join() !== 'tokens,version' || !Array.isArray(doc.tokens)) throw new Error();
        state = {
          version: 2,
          linkSecret: randomBytes(32).toString('base64url'),
          tokens: doc.tokens.map(token => {
            if (!token || typeof token !== 'object' || Array.isArray(token)) throw new Error();
            return { ...(token as SavedToken), scopes: [...tokenScopes] };
          }),
        };
        rewrite = true;
      } else {
        state = parsed as Document;
      }
      if (Object.keys(state).sort().join() !== 'linkSecret,tokens,version' || state.version !== 2
        || typeof state.linkSecret !== 'string' || !/^[\w-]{43}$/.test(state.linkSecret)
        || !Array.isArray(state.tokens) || state.tokens.length > MAX_TOKENS) throw new Error();
      const ids = new Set<string>();
      for (const token of state.tokens) {
        if (!token || Object.keys(token).sort().join() !== 'createdAt,digest,id,lastUsedAt,name,quotas,scopes' || !/^[a-f0-9]{32}$/.test(token.id) || ids.has(token.id) || !/^[a-f0-9]{64}$/.test(token.digest) || !Number.isFinite(token.createdAt) || (token.lastUsedAt !== null && !Number.isFinite(token.lastUsedAt))) throw new Error();
        if (Object.keys(token.quotas).sort().join() !== 'concurrentRequests,requestsPerMinute') throw new Error();
        tokenOptions({ name: token.name, quotas: token.quotas, scopes: token.scopes });
        ids.add(token.id);
      }
    } catch { throw new Error('Store access storage is invalid; restore store.json.'); }
    if (rewrite) await atomicWriteJson(path, state);
    await chmod(path, 0o600);
    return new JsonStoreAccess(path, state);
  }
  list(): StoreToken[] { return this.state.tokens.map(({ digest: _, ...token }) => structuredClone(token)); }

  // Full document, including token digests and the raw link secret. Used only
  // by the one-time SQLite importer, never by application code.
  dump(): Document { return structuredClone(this.state); }
  // The raw key that signs expiring `/api/v1` download links. Internal only —
  // never surfaced through `list()` or any response.
  linkSecret(): Buffer { return Buffer.from(this.state.linkSecret, 'base64url'); }
  async create(input: unknown): Promise<{ token: string; item: StoreToken }> {
    const options = tokenOptions(input);
    const token = randomBytes(32).toString('base64url');
    const item: StoreToken = { id: randomBytes(16).toString('hex'), ...options, createdAt: Date.now(), lastUsedAt: null };
    await this.write(state => {
      if (state.tokens.length >= MAX_TOKENS) throw new BusyError();
      return { ...state, tokens: [...state.tokens, { ...item, digest: digest(token).toString('hex') }] };
    });
    return { token, item };
  }
  async revoke(id: string): Promise<void> {
    await this.write(state => ({ ...state, tokens: state.tokens.filter(t => t.id !== id) }));
    this.usage.delete(id);
  }
  // Source addresses come from the socket, never from untrusted forwarding headers.
  async authenticate(token: string, address: string, now = Date.now()): Promise<StoreToken | undefined> {
    for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    if ((this.failures.get(address)?.count ?? 0) >= 5) throw new StoreAuthThrottle();
    const hash = digest(token);
    const found = this.state.tokens.find(t => timingSafeEqual(hash, Buffer.from(t.digest, 'hex')));
    if (!found) {
      if (!this.failures.has(address) && this.failures.size >= 1000) throw new StoreAuthThrottle();
      const attempt = this.failures.get(address) ?? { count: 0, until: now + 900_000 };
      attempt.count++;
      this.failures.set(address, attempt);
      return undefined;
    }
    this.failures.delete(address);
    if (found.lastUsedAt === null || now - found.lastUsedAt >= 60_000) {
      await this.write(state => ({ ...state, tokens: state.tokens.map(t => t.id === found.id ? { ...t, lastUsedAt: now } : t) }));
    }
    return this.list().find(t => t.id === found.id);
  }
  enter(token: StoreToken, now = Date.now()): () => void {
    if (!this.state.tokens.some(t => t.id === token.id)) throw new BusyError();
    const use = this.usage.get(token.id) ?? { starts: [], active: 0 };
    use.starts = use.starts.filter(t => now - t < 60_000);
    if (use.active >= token.quotas.concurrentRequests || use.starts.length >= token.quotas.requestsPerMinute) throw new BusyError();
    use.starts.push(now); use.active++;
    this.usage.set(token.id, use);
    let released = false;
    return () => { if (!released) { released = true; use.active--; } };
  }
  private write(update: (state: Document) => Document): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = update(this.state);
      await atomicWriteJson(this.path, next);
      this.state = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
