import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class DataDirLockedError extends Error {}

interface LockRecord { pid: number; token: string; createdAt: string }

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readRecord(path: string): LockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (Number.isInteger(value.pid) && typeof value.token === 'string' && typeof value.createdAt === 'string') return value as LockRecord;
  } catch { /* malformed locks are treated as stale */ }
  return undefined;
}

// DATA_DIR contains process-local sessions, admission counters, and job
// leases, so sharing it between live processes is unsafe. An exclusive file
// makes that deployment error fail at startup. A lock left by a dead process
// is recovered once; the random token prevents an old owner's cleanup from
// unlinking a replacement lock.
export function acquireDataDirLock(dataDir: string): () => void {
  const path = join(dataDir, '.debridarr.lock');
  const record: LockRecord = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new DataDirLockedError('Cannot create the DATA_DIR lock file. Check DATA_DIR and its permissions.');
      const owner = readRecord(path);
      if (owner && processExists(owner.pid)) {
        throw new DataDirLockedError(`DATA_DIR is already in use by Debridarr process ${owner.pid}. Run only one instance per data directory.`);
      }
      try { unlinkSync(path); }
      catch { throw new DataDirLockedError('DATA_DIR has a stale lock that could not be removed. Check DATA_DIR and its permissions.'); }
    }
  }
  if (fd === undefined) throw new DataDirLockedError('Could not acquire the DATA_DIR lock.');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(fd); } catch { /* already closed */ }
    if (readRecord(path)?.token === record.token) {
      try { unlinkSync(path); } catch { /* best effort during shutdown */ }
    }
  };
}
