import type { JobRecord, JobsRepository } from '../repositories.js';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { objectRecord } from '../../json.js';
import { atomicWriteJson } from '../../storage.js';

export class JsonJobsStore implements JobsRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly rows = new Map<string, JobRecord>();
  private readonly path: string | undefined;

  constructor(path?: string, records: JobRecord[] = []) {
    this.path = path;
    for (const record of records) this.rows.set(record.id, record);
  }

  static async open(dataDir: string): Promise<JsonJobsStore> {
    const path = join(dataDir, 'jobs.json');
    let contents: string | undefined;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try { contents = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch { throw new Error('Cannot read job storage. Check DATA_DIR and its permissions.'); }
    if (contents === undefined) {
      const store = new JsonJobsStore(path);
      await store.persist([]);
      return store;
    }
    let records: JobRecord[];
    try {
      const document = objectRecord(JSON.parse(contents));
      if (!document || document.version !== 1 || !Array.isArray(document.jobs) || document.jobs.length > 10_000) throw new Error();
      records = document.jobs.map(value => {
        const row = objectRecord(value);
        if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 512 || typeof row.kind !== 'string' || !row.kind
          || (row.payload !== null && typeof row.payload !== 'string') || !Number.isInteger(row.attempts) || (row.attempts as number) < 0
          || !Number.isFinite(row.nextRunAt) || (row.leaseUntil !== null && !Number.isFinite(row.leaseUntil))
          || (row.leaseId !== null && typeof row.leaseId !== 'string') || (row.lastError !== null && typeof row.lastError !== 'string')) throw new Error();
        return row as unknown as JobRecord;
      });
      if (new Set(records.map(row => row.id)).size !== records.length) throw new Error();
    } catch { throw new Error('Job storage is invalid; restore jobs.json.'); }
    try { await chmod(path, 0o600); } catch { /* best effort */ }
    return new JsonJobsStore(path, records);
  }

  list(): JobRecord[] {
    return [...this.rows.values()].map(row => ({ ...row }));
  }

  async ensure(id: string, kind: string, nextRunAt: number, payload: string | null = null): Promise<void> {
    await this.write(rows => {
      if (!rows.has(id)) rows.set(id, { id, kind, payload, attempts: 0, nextRunAt, leaseUntil: null, leaseId: null, lastError: null });
    });
  }

  async claimDue(now: number, leaseMs: number, leaseId: string): Promise<JobRecord | undefined> {
    let claimed: JobRecord | undefined;
    await this.write(rows => {
      const job = [...rows.values()]
        .filter(row => row.nextRunAt <= now && (row.leaseUntil === null || row.leaseUntil < now))
        .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
      if (job) {
        claimed = { ...job, leaseUntil: now + leaseMs, leaseId };
        rows.set(job.id, claimed);
      }
    });
    return claimed ? { ...claimed } : undefined;
  }

  async reschedule(id: string, nextRunAt: number, attempts: number, lastError: string | null): Promise<void> {
    await this.write(rows => {
      const job = rows.get(id);
      if (job) rows.set(id, { ...job, nextRunAt, attempts, leaseUntil: null, leaseId: null, lastError });
    });
  }

  async remove(id: string): Promise<void> {
    await this.write(rows => { rows.delete(id); });
  }

  private write(mutate: (rows: Map<string, JobRecord>) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = new Map(this.rows);
      mutate(next);
      await this.persist([...next.values()]);
      this.rows.clear();
      for (const [id, row] of next) this.rows.set(id, row);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private persist(jobs: JobRecord[]): Promise<void> {
    return this.path ? atomicWriteJson(this.path, { version: 1, jobs }) : Promise.resolve();
  }
}
