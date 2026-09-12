import { DEBRIDARR_SCOPE } from '../downloads/manager.js';
import type { DownloadBackend, DownloadSnapshot } from './download.js';
import { BACKEND_READ_TIMEOUT_MS } from '../timeouts.js';

const TTL_MS = 5_000;

export interface BackendSnapshot {
  at: number;
  byHash: Map<string, DownloadSnapshot>;
}

const snapshots = new Map<string, Promise<BackendSnapshot>>();

// One process-wide list of owned jobs, shared by TransferService, the admin
// dashboard, and addon cache browsing. Mutations must call
// `invalidateBackendSnapshot` so the next reader does not serve a stale list.
export async function backendSnapshot(backend: DownloadBackend, signal?: AbortSignal): Promise<BackendSnapshot> {
  const cached = snapshots.get(backend.identity);
  if (cached) {
    const value = await cached;
    if (Date.now() - value.at <= TTL_MS) return value;
    if (snapshots.get(backend.identity) !== cached) return backendSnapshot(backend, signal);
  }
  const pending = backend.list(DEBRIDARR_SCOPE, signal ?? AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS))
    .then(list => ({ at: Date.now(), byHash: new Map(list.map(t => [t.infoHash, t])) }));
  if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(backend.identity, pending);
  try { return await pending; }
  catch (error) { if (snapshots.get(backend.identity) === pending) snapshots.delete(backend.identity); throw error; }
}

export function invalidateBackendSnapshot(identity: string): void {
  snapshots.delete(identity);
}

export function clearBackendSnapshots(): void {
  snapshots.clear();
}
