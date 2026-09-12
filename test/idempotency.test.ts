import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdempotencyCache, type StoredResponse } from '../src/api/v1/idempotency.js';
import { JsonIdempotencyStore } from '../src/state/json/idempotency.js';

test('concurrent callers with the same key race one compute and both replay its result', async () => {
  const cache = new IdempotencyCache(new JsonIdempotencyStore());
  let calls = 0;
  const compute = async (): Promise<StoredResponse> => { calls += 1; return { status: 201, body: { n: calls } }; };
  const [a, b] = await Promise.all([cache.run('tok', 'key', compute), cache.run('tok', 'key', compute)]);
  assert.equal(calls, 1);
  assert.deepEqual(a!.response, b!.response);
  assert.ok(a!.replay !== b!.replay);
});

test('a fresh IdempotencyCache backed by the same repository replays across restarts', async () => {
  const repo = new JsonIdempotencyStore();
  const first = new IdempotencyCache(repo);
  const { response: created, replay: firstReplay } = await first.run('tok', 'key', async () => ({ status: 201, body: { id: 'abc' } }));
  assert.equal(firstReplay, false);

  const second = new IdempotencyCache(repo);
  let recomputed = false;
  const { response: replayed, replay: secondReplay } = await second.run('tok', 'key', async () => { recomputed = true; return { status: 500, body: {} }; });
  assert.equal(secondReplay, true);
  assert.equal(recomputed, false);
  assert.deepEqual(replayed, created);
});

test('a failed compute is not persisted and can be retried', async () => {
  const cache = new IdempotencyCache(new JsonIdempotencyStore());
  await assert.rejects(cache.run('tok', 'key', async () => { throw new Error('boom'); }));
  const { response, replay } = await cache.run('tok', 'key', async () => ({ status: 201, body: { ok: true } }));
  assert.equal(replay, false);
  assert.deepEqual(response, { status: 201, body: { ok: true } });
});
