import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquireDataDirLock, DataDirLockedError } from '../src/state/lock.js';
import { tmpDir } from './helpers.js';

test('DATA_DIR lock refuses a second live owner and is released idempotently', async t => {
  const dataDir = await tmpDir(t, 'debridarr-lock');
  const release = acquireDataDirLock(dataDir);
  assert.throws(() => acquireDataDirLock(dataDir), DataDirLockedError);
  release();
  release();
  const releaseAgain = acquireDataDirLock(dataDir);
  releaseAgain();
});

test('DATA_DIR lock recovers a malformed or dead-process lock', async t => {
  const dataDir = await tmpDir(t, 'debridarr-lock-stale');
  const path = join(dataDir, '.debridarr.lock');
  await writeFile(path, '{not json}\n');
  acquireDataDirLock(dataDir)();
  await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: 'old', createdAt: 'yesterday' }));
  acquireDataDirLock(dataDir)();
});
