// Idempotency for `POST /api/v1/transfers`. A client that retries a create
// with the same `Idempotency-Key` gets the original response back instead of
// a second submission. Keys are scoped per token.
//
// Completed responses are durable, via `IdempotencyRepository` (SQLite by
// default; a restart still replays a pre-restart key). The in-flight map
// below only coalesces concurrent callers racing the same key before the
// first one has committed a result — a `Promise` cannot itself survive a
// restart, so it never needs to.
import type { IdempotencyRepository } from '../../state/repositories.js';

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{1,255}$/;

export interface StoredResponse { status: number; body: unknown }

export class IdempotencyCache {
  private readonly inflight = new Map<string, Promise<StoredResponse>>();
  private readonly repo: IdempotencyRepository;
  private readonly now: () => number;
  constructor(repo: IdempotencyRepository, now: () => number = Date.now) {
    this.repo = repo;
    this.now = now;
  }

  // Runs `compute` once per (tokenId, key); concurrent and later callers await
  // the same result. `replay` is true for every caller after the first.
  async run(tokenId: string, key: string, compute: () => Promise<StoredResponse>): Promise<{ response: StoredResponse; replay: boolean }> {
    const id = `${tokenId}\0${key}`;
    const flight = this.inflight.get(id);
    if (flight) return { response: await flight, replay: true };
    const stored = this.repo.get(id, this.now());
    if (stored) return { response: stored, replay: true };
    const result = compute();
    this.inflight.set(id, result);
    try {
      const response = await result;
      await this.repo.put(id, response, this.now());
      return { response, replay: false };
    } finally {
      this.inflight.delete(id);
    }
  }
}
