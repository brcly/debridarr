// Pure repository contracts for the four durable stores. No fs or node:sqlite
// import is reachable from this module: core code depends only on these
// shapes, never on a concrete JSON or SQLite implementation.
import type { Settings } from '../settings.js';
import type { DownloadRecord } from '../downloads/store.js';
import type { StoreToken } from '../store/access.js';
import type { PrepareTransferRequest } from '../application/types.js';

export interface SettingsRepository {
  snapshot(): Settings;
  update(input: unknown): Promise<Settings>;
}

export interface DownloadsRepository {
  list(): DownloadRecord[];
  get(infoHash: string): DownloadRecord | undefined;
  upsert(record: DownloadRecord): Promise<DownloadRecord>;
  remove(infoHash: string): Promise<void>;
  setKept(infoHash: string, kept: boolean): Promise<DownloadRecord | undefined>;
  renew(infoHash: string, expiresAt: number): Promise<DownloadRecord | undefined>;
}

export interface StoreAccessRepository {
  list(): StoreToken[];
  linkSecret(): Buffer;
  create(input: unknown): Promise<{ token: string; item: StoreToken }>;
  revoke(id: string): Promise<void>;
  authenticate(token: string, address: string, now?: number): Promise<StoreToken | undefined>;
  enter(token: StoreToken, now?: number): () => void;
}

export interface AddonAccessRepository {
  valid(key: string): boolean;
  base(appUrl: string): string;
  get(id: string, source: string, now?: number): PrepareTransferRequest | undefined;
  issue(requests: PrepareTransferRequest[], source: string, now?: number): Promise<string[]>;
  rotate(): Promise<void>;
  invalidate(): Promise<void>;
  // Drop rows whose TTL has elapsed. Reads already ignore them; this reclaims
  // space without waiting for the next issue/rotate. Returns how many went.
  pruneExpired(now?: number): Promise<number>;
}

export interface IdempotencyEntry { status: number; body: unknown }

// Expiry and eviction are the repository's problem: `get` returns undefined
// for an expired or unknown id, and `put` is free to prune internally.
export interface IdempotencyRepository {
  get(id: string, now: number): IdempotencyEntry | undefined;
  put(id: string, entry: IdempotencyEntry, now: number): Promise<void>;
}

export interface JobRecord {
  id: string;
  kind: string;
  payload: string | null;
  attempts: number;
  nextRunAt: number;
  leaseUntil: number | null;
  leaseId: string | null;
  lastError: string | null;
}

// Persisted intent for the bounded job runner: `ensure` seeds a job once
// (idempotent registration), `claimDue` atomically leases the next eligible
// job so a crashed or restarted process never runs two copies of the same
// job at once, and `reschedule` clears the lease and records the next
// attempt (or backoff) in the same write.
export interface JobsRepository {
  list(): JobRecord[];
  ensure(id: string, kind: string, nextRunAt: number, payload?: string | null): Promise<void>;
  claimDue(now: number, leaseMs: number, leaseId: string): Promise<JobRecord | undefined>;
  reschedule(id: string, nextRunAt: number, attempts: number, lastError: string | null): Promise<void>;
  remove(id: string): Promise<void>;
}
