import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BusyError } from '../../security/admission.js';
import { digest, MAX_TOKENS, StoreAuthThrottle, tokenOptions, type SavedToken, type StoreToken } from '../../store/access.js';
import { ensureSecretsRow } from './db.js';

interface Row { record: string }

export class SqliteStoreAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private failures = new Map<string, { count: number; until: number }>();
  private usage = new Map<string, { starts: number[]; active: number }>();
  private readonly linkSecretValue: string;

  private readonly db: DatabaseSync;
  private constructor(db: DatabaseSync, linkSecret: string) {
    this.db = db;
    this.linkSecretValue = linkSecret;
  }

  static open(db: DatabaseSync): SqliteStoreAccess {
    const { linkSecret } = ensureSecretsRow(db);
    return new SqliteStoreAccess(db, linkSecret);
  }

  private tokens(): SavedToken[] {
    const rows = this.db.prepare('SELECT record FROM tokens').all() as unknown as Row[];
    return rows.map(row => JSON.parse(row.record) as SavedToken);
  }

  list(): StoreToken[] {
    return this.tokens().map(({ digest: _, ...token }) => structuredClone(token));
  }

  // The raw key that signs expiring `/api/v1` download links. Internal only —
  // never surfaced through `list()` or any response.
  linkSecret(): Buffer { return Buffer.from(this.linkSecretValue, 'base64url'); }

  async create(input: unknown): Promise<{ token: string; item: StoreToken }> {
    const options = tokenOptions(input);
    const token = randomBytes(32).toString('base64url');
    const item: StoreToken = { id: randomBytes(16).toString('hex'), ...options, createdAt: Date.now(), lastUsedAt: null };
    await this.write(() => {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n;
      if (count >= MAX_TOKENS) throw new BusyError();
      const saved: SavedToken = { ...item, digest: digest(token).toString('hex') };
      this.db.prepare('INSERT INTO tokens (id, record) VALUES (?, ?)').run(saved.id, JSON.stringify(saved));
    });
    return { token, item };
  }

  async revoke(id: string): Promise<void> {
    await this.write(() => { this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id); });
    this.usage.delete(id);
  }

  // Source addresses come from the socket, never from untrusted forwarding headers.
  async authenticate(token: string, address: string, now = Date.now()): Promise<StoreToken | undefined> {
    for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    if ((this.failures.get(address)?.count ?? 0) >= 5) throw new StoreAuthThrottle();
    const hash = digest(token);
    const found = this.tokens().find(t => timingSafeEqual(hash, Buffer.from(t.digest, 'hex')));
    if (!found) {
      if (!this.failures.has(address) && this.failures.size >= 1000) throw new StoreAuthThrottle();
      const attempt = this.failures.get(address) ?? { count: 0, until: now + 900_000 };
      attempt.count++;
      this.failures.set(address, attempt);
      return undefined;
    }
    this.failures.delete(address);
    if (found.lastUsedAt === null || now - found.lastUsedAt >= 60_000) {
      await this.write(() => {
        const updated: SavedToken = { ...found, lastUsedAt: now };
        this.db.prepare('UPDATE tokens SET record = ? WHERE id = ?').run(JSON.stringify(updated), found.id);
      });
    }
    return this.list().find(t => t.id === found.id);
  }

  enter(token: StoreToken, now = Date.now()): () => void {
    if (!this.tokens().some(t => t.id === token.id)) throw new BusyError();
    const use = this.usage.get(token.id) ?? { starts: [], active: 0 };
    use.starts = use.starts.filter(t => now - t < 60_000);
    if (use.active >= token.quotas.concurrentRequests || use.starts.length >= token.quotas.requestsPerMinute) throw new BusyError();
    use.starts.push(now); use.active++;
    this.usage.set(token.id, use);
    let released = false;
    return () => { if (!released) { released = true; use.active--; } };
  }

  private write(mutate: () => void): Promise<void> {
    const operation = this.queue.then(async () => { mutate(); });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
