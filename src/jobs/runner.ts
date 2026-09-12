import { randomUUID } from 'node:crypto';
import type { JobRecord, JobsRepository } from '../state/repositories.js';

export interface JobHandlers {
  sweep: () => Promise<void>;
  recovery: () => Promise<void>;
  deleteRetry: (infoHash: string) => Promise<{ retry: boolean }>;
  rss: () => Promise<void>;
}

const SWEEP_ID = 'sweep';
const RECOVERY_ID = 'recovery';
const RSS_ID = 'rss';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 15_000;
const RSS_INTERVAL_MS = 15 * 60 * 1000;
const TICK_MS = 5_000;
const LEASE_MS = 30_000;
const MAX_CONCURRENT = 2;
const MIN_RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 300_000;

const deletionRetryId = (infoHash: string): string => `delete-retry:${infoHash}`;
const backoff = (attempts: number): number => Math.min(MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS * 2 ** attempts);

// One bounded scheduler in place of the three independent `setInterval`
// polling loops it replaces. Sweep and recovery are recurring jobs seeded
// once and rescheduled after every run; a sweep's failed deletions become
// one-off retry jobs with their own backoff instead of waiting for the next
// hourly sweep. Persisted intent plus a lease per claimed job means a
// restart resumes at the next due time rather than re-running everything
// from scratch, but this is one-process only: a second replica sharing the
// same SQLite file would still race to claim the same job, since leases are
// advisory within a single runner's clock, not a cross-process fencing
// token. Multi-replica would need a real lock (e.g. compare-and-swap on
// lease ownership with a monotonic fencing token) and a single writer for
// the database file, neither of which exists here.
export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight = 0;
  private runner!: string;
  private pending: Promise<void>[] = [];
  private readonly jobs: JobsRepository;
  private readonly handlers: JobHandlers;
  private readonly now: () => number;

  constructor(jobs: JobsRepository, handlers: JobHandlers, now: () => number = Date.now) {
    this.jobs = jobs;
    this.handlers = handlers;
    this.now = now;
  }

  async start(): Promise<void> {
    this.runner = randomUUID();
    await this.jobs.ensure(SWEEP_ID, 'sweep', this.now());
    await this.jobs.ensure(RECOVERY_ID, 'recovery', this.now());
    await this.jobs.ensure(RSS_ID, 'rss', this.now());
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // Wait for jobs already claimed. Does not claim new work (`stop` first).
  async drain(timeoutMs = 4_000): Promise<void> {
    if (!this.pending.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.pending),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  scheduleDeletionRetry(infoHash: string): void {
    void this.jobs.ensure(deletionRetryId(infoHash), 'delete-retry', this.now() + MIN_RETRY_DELAY_MS, infoHash);
  }

  // Awaits every job claimed by the most recent tick. Tests use this for a
  // deterministic tick instead of racing the runner's own interval; normal
  // operation never calls it, since a tick is meant to hand jobs off and
  // move on rather than block.
  async tick(): Promise<void> {
    if (this.stopped) return;
    while (!this.stopped && this.inFlight < MAX_CONCURRENT) {
      const job = await this.jobs.claimDue(this.now(), LEASE_MS, this.runner);
      if (!job) break;
      this.inFlight++;
      const run = this.run(job).finally(() => {
        this.inFlight--;
        this.pending = this.pending.filter(p => p !== run);
      });
      this.pending.push(run);
    }
    await Promise.all(this.pending);
  }

  private async run(job: JobRecord): Promise<void> {
    try {
      if (job.kind === 'sweep') {
        await this.handlers.sweep();
        await this.jobs.reschedule(job.id, this.now() + SWEEP_INTERVAL_MS, 0, null);
      } else if (job.kind === 'recovery') {
        await this.handlers.recovery();
        await this.jobs.reschedule(job.id, this.now() + RECOVERY_INTERVAL_MS, 0, null);
      } else if (job.kind === 'rss') {
        await this.handlers.rss();
        await this.jobs.reschedule(job.id, this.now() + RSS_INTERVAL_MS, 0, null);
      } else if (job.kind === 'delete-retry') {
        if (job.payload === null) { await this.jobs.remove(job.id); return; }
        const { retry } = await this.handlers.deleteRetry(job.payload);
        if (retry) await this.jobs.reschedule(job.id, this.now() + backoff(job.attempts), job.attempts + 1, null);
        else await this.jobs.remove(job.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobs.reschedule(job.id, this.now() + backoff(job.attempts), job.attempts + 1, message);
    }
  }
}
