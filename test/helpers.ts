import { once } from 'node:events';
import type { Server } from 'node:http';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearBackendSnapshots } from '../src/backends/snapshot.js';
import { clearDownloadBackends } from '../src/backends/factory.js';
import { resetRequestCounters } from '../src/metrics.js';
import type { PrepareTransferRequest } from '../src/application/types.js';

// A fresh temp directory, cleaned up automatically when the test ends.
export async function tmpDir(t: TestContext, prefix = 'debridarr'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `${prefix}-`));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

// A compact shorthand for playback-request literals in tests, mirroring the
// release/cached-copy → PrepareTransferRequest mapping the addon layer performs.
export interface PlayShape {
  title: string;
  size: number;
  imdbId?: string;
  type?: 'movie' | 'series';
  season?: number;
  episode?: number;
  infoHash?: string;
  magnetUrl?: string;
  downloadUrl?: string;
  origin?: 'search' | 'store';
  cachedFile?: { index: number; name: string; bytes: number; ownerTag: string };
  storeFile?: { index: number; name: string; bytes: number; ownerTag: string };
}

export function playRequest(shape: PlayShape): PrepareTransferRequest {
  const httpUrl = shape.downloadUrl ?? (shape.magnetUrl?.startsWith('http') ? shape.magnetUrl : undefined);
  const source = httpUrl ? { downloadUrl: httpUrl }
    : shape.magnetUrl ? { magnet: shape.magnetUrl }
    : { infoHash: (shape.infoHash ?? '').toLowerCase() };
  const selected = shape.cachedFile ?? shape.storeFile;
  return {
    source,
    origin: shape.origin ?? 'search',
    name: shape.title,
    bytes: shape.size,
    ...(shape.imdbId && shape.type ? { media: {
      imdbId: shape.imdbId,
      type: shape.type,
      ...(shape.season === undefined ? {} : { season: shape.season }),
      ...(shape.episode === undefined ? {} : { episode: shape.episode }),
    } } : {}),
    ...(selected ? { selection: {
      file: { id: selected.index, path: selected.name, bytes: selected.bytes, marker: selected.ownerTag },
      behavior: shape.storeFile ? 'allow-select' as const : 'require-existing' as const,
    } } : {}),
  };
}

export const requestHash = (request: PrepareTransferRequest | undefined): string | undefined =>
  request && 'infoHash' in request.source ? request.source.infoHash : undefined;

export async function listen(server: Server, t: TestContext): Promise<string> {
  clearBackendSnapshots();
  clearDownloadBackends();
  resetRequestCounters();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  return `http://127.0.0.1:${address.port}`;
}
