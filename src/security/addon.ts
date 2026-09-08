import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../storage.js';
import { isPlayTarget, type PlayTarget } from '../addon/play.js';

const MAX_REFERENCES = 1000;
const TTL = 24 * 60 * 60 * 1000;
const identifier = () => randomBytes(32).toString('base64url');
interface Reference { id: string; created: number; source: string; target: PlayTarget }
interface Document { version: 1; key: string; references: Reference[] }
export function sourceIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export class AddonAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private path: string, private state: Document) {}
  static async open(dataDir: string): Promise<AddonAccess> {
    const path = join(dataDir, 'addon.json');
    let state: Document;
    try { state = JSON.parse(await readFile(path, 'utf8')) as Document; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Addon access storage is invalid; restore addon.json.');
      state = { version: 1, key: identifier(), references: [] };
      await atomicWriteJson(path, state);
    }
    if (!state || typeof state !== 'object' || state.version !== 1 || !/^[\w-]{43}$/.test(state.key) || !Array.isArray(state.references)
      || state.references.length > MAX_REFERENCES || state.references.some(r => !r || typeof r !== 'object' || !/^[\w-]{43}$/.test(r.id)
        || !Number.isFinite(r.created) || typeof r.source !== 'string' || !isPlayTarget(r.target)
        || Buffer.byteLength(JSON.stringify(r.target)) > 16384)) throw new Error('Addon access storage is invalid; restore addon.json.');
    await chmod(path, 0o600);
    return new AddonAccess(path, state);
  }
  valid(key: string): boolean {
    return key.length === this.state.key.length && timingSafeEqual(Buffer.from(key), Buffer.from(this.state.key));
  }
  base(appUrl: string): string { return `${appUrl}/addon/${this.state.key}`; }
  get(id: string, source: string, now = Date.now()): PlayTarget | undefined {
    const entry = this.state.references.find(r => r.id === id && r.source === source && r.created + TTL > now);
    return entry ? structuredClone(entry.target) : undefined;
  }
  async issue(targets: PlayTarget[], source: string, now = Date.now()): Promise<string[]> {
    const entries = targets.map(target => {
      if (!isPlayTarget(target)) throw new Error('Invalid release reference');
      if (Buffer.byteLength(JSON.stringify(target)) > 16384) throw new Error('Release reference too large');
      return { id: identifier(), created: now, source, target: structuredClone(target) };
    });
    await this.write(state => ({ ...state, references: [...state.references.filter(r => r.created + TTL > now && r.source === source), ...entries].slice(-MAX_REFERENCES) }));
    return entries.map(r => r.id);
  }
  rotate(): Promise<void> { return this.write(() => ({ version: 1, key: identifier(), references: [] })); }
  invalidate(): Promise<void> { return this.write(state => ({ ...state, references: [] })); }
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
