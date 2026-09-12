import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobRunner } from '../src/jobs/runner.js';
import { JsonJobsStore } from '../src/state/json/jobs.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function withClock(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('sweep and recovery run once on start and are not repeated by a tick before their interval', async () => {
  const jobs = new JsonJobsStore();
  const clock = withClock(1_000_000);
  let sweepCalls = 0;
  let recoveryCalls = 0;
  const runner = new JobRunner(jobs, {
    sweep: async () => { sweepCalls++; },
    recovery: async () => { recoveryCalls++; },
    deleteRetry: async () => ({ retry: false }),
    rss: async () => {},
  }, clock.now);
  await runner.start();
  await new Promise(r => setTimeout(r, 20));
  runner.stop();
  await runner.drain();
  assert.equal(sweepCalls, 1);
  assert.equal(recoveryCalls, 1);
});

test('a failed deletion during sweep is retried with backoff instead of waiting for the next sweep', async () => {
  const jobs = new JsonJobsStore();
  const clock = withClock(1_000_000);
  const attempts: number[] = [];
  const retryDone = deferred<void>();
  const runner = new JobRunner(jobs, {
    sweep: async () => { runner.scheduleDeletionRetry('a'.repeat(40)); },
    recovery: async () => {},
    deleteRetry: async () => {
      attempts.push(clock.now());
      if (attempts.length < 2) return { retry: true };
      retryDone.resolve();
      return { retry: false };
    },
    rss: async () => {},
  }, clock.now);
  await runner.start();
  await new Promise(r => setTimeout(r, 10)); // sweep runs, schedules the retry job
  await runner.tick(); // drain the third initially-seeded job (rss) so it does not outrank the retry later

  clock.advance(15_000); // first retry becomes due
  await runner.tick();
  assert.equal(attempts.length, 1);
  assert.equal(jobs.list().find(j => j.kind === 'delete-retry')?.attempts, 1);

  clock.advance(30_000); // backoff doubled to 30s
  await runner.tick();
  await retryDone.promise;
  assert.equal(attempts.length, 2);
  assert.equal(jobs.list().find(j => j.kind === 'delete-retry'), undefined, 'job removed once deletion succeeds');
  runner.stop();
  await runner.drain();
});

test('claimed jobs are bounded: a third due job waits while two are in flight', async () => {
  const jobs = new JsonJobsStore();
  const clock = withClock(2_000_000);
  await jobs.ensure('a', 'delete-retry', 0, 'a'.repeat(40));
  await jobs.ensure('b', 'delete-retry', 0, 'b'.repeat(40));
  await jobs.ensure('c', 'delete-retry', 0, 'c'.repeat(40));

  let running = 0;
  let maxRunning = 0;
  const gate = deferred<void>();
  const runner = new JobRunner(jobs, {
    sweep: async () => {},
    recovery: async () => {},
    deleteRetry: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running--;
      return { retry: false };
    },
    rss: async () => {},
  }, clock.now);
  await runner.start();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(maxRunning, 2, 'the third due delete-retry job waits for a free slot');
  gate.resolve();
  await new Promise(r => setTimeout(r, 10));
  runner.stop();
  await runner.drain();
});

test('drain waits for in-flight jobs after stop, and does not claim further work', async () => {
  const jobs = new JsonJobsStore();
  const clock = withClock(3_000_000);
  await jobs.ensure('a', 'delete-retry', 0, 'a'.repeat(40));
  const started = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const runner = new JobRunner(jobs, {
    sweep: async () => {},
    recovery: async () => {},
    deleteRetry: async () => {
      calls++;
      started.resolve();
      await release.promise;
      return { retry: false };
    },
    rss: async () => {},
  }, clock.now);
  await runner.start();
  await started.promise;
  runner.stop();
  const draining = runner.drain(2_000);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1);
  release.resolve();
  await draining;
  assert.equal(calls, 1);
});
