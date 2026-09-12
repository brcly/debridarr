import { DAY_MS } from '../downloads/manager.js';
import type { DownloadRecord } from '../downloads/store.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { createDownloadBackend } from '../backends/factory.js';
import type { DownloadBackend, DownloadSnapshot } from '../backends/download.js';
import { isActive as isActiveDefault } from '../playback/active.js';
import type { Settings } from '../settings.js';
import type { SettingsRepository } from '../state/repositories.js';
import { coordinated } from '../downloads/coordinator.js';
import { verifyOwnership } from '../downloads/ownership.js';
import { deleteManaged } from '../downloads/deletion.js';
import { SWEEP_TIMEOUT_MS } from '../timeouts.js';

export interface SweepDeps {
  store: SettingsRepository;
  downloads: DownloadsRepository;
  backendFactory?: (settings: Settings['downloadBackend']) => DownloadBackend;
  isActive?: (infoHash: string) => boolean;
  now?: () => number;
}
export interface SweepResult {
  deleted: string[]; evicted: string[]; staleRemoved: string[]; failed: string[];
  skipped?: 'download_backend_unconfigured' | 'download_backend_unreachable';
}

// Shared by the sweep's expiry pass and the job runner's per-hash deletion
// retry, so a retry applies exactly the same rule the sweep would have.
function isExpired(record: DownloadRecord, torrent: DownloadSnapshot, settings: Settings, now: number): boolean {
  if (record.lifecycle === 'deleting') return true;
  if (record.kept) return false;
  if (record.lifecycle === 'failed') return true;
  return now >= record.expiresAt && (torrent.ratio >= settings.retention.targetRatio
    || (settings.retention.graceDays > 0 && now >= record.expiresAt + settings.retention.graceDays * DAY_MS));
}

// Retries a single deletion that failed during a sweep, without waiting for
// the next hourly tick. Returns `retry: true` when the caller should
// reschedule (record still present, deletion did not complete).
export async function retryDeletion(hash: string, deps: SweepDeps): Promise<{ retry: boolean }> {
  const record = deps.downloads.get(hash);
  if (!record) return { retry: false };
  const settings = deps.store.snapshot();
  const backend = (deps.backendFactory ?? createDownloadBackend)(settings.downloadBackend);
  if (!backend.configured) return { retry: true };
  const signal = AbortSignal.timeout(SWEEP_TIMEOUT_MS);
  const now = deps.now ?? Date.now;
  const active = deps.isActive ?? isActiveDefault;
  try {
    const removed = await deleteManaged(deps.downloads, backend, hash, signal,
      (r, t) => isExpired(r, t, settings, now()), active);
    return { retry: !removed };
  } catch {
    return { retry: true };
  }
}

export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const settings = deps.store.snapshot();
  const backend = (deps.backendFactory ?? createDownloadBackend)(settings.downloadBackend);
  const result: SweepResult = { deleted: [], evicted: [], staleRemoved: [], failed: [] };
  if (!backend.configured) return { ...result, skipped: 'download_backend_unconfigured' };
  const signal = AbortSignal.timeout(SWEEP_TIMEOUT_MS);
  const now = deps.now ?? Date.now;
  const active = deps.isActive ?? isActiveDefault;
  const live = new Map<string, DownloadSnapshot>();
  for (const snapshot of deps.downloads.list()) {
    const hash = snapshot.infoHash;
    try {
      await coordinated(deps.downloads, hash, async () => {
        const record = deps.downloads.get(hash);
        if (!record) return;
        const torrent = await backend.get(hash, signal);
        if (record.owner && record.owner.backend !== backend.identity) {
          await deps.downloads.upsert({ ...record, lifecycle: 'conflict', failure: 'client_changed' });
          return;
        }
        if (!torrent) {
          if (record.owner && record.lifecycle !== 'registering' && !active(hash)) {
            await deps.downloads.remove(hash); result.staleRemoved.push(hash);
          } else if (!record.owner) await deps.downloads.upsert({ ...record, lifecycle: 'conflict', failure: 'legacy_torrent_missing' });
          return;
        }
        const verified = await verifyOwnership(record, torrent, backend, deps.downloads, signal);
        live.set(hash, torrent);
        if (verified.lifecycle !== 'deleting') {
          await backend.capabilities.seedLimits?.(hash, { ratioLimit: -1, seedingTimeLimit: -1 }, signal);
          if (torrent.progress === 1 && torrent.ratio >= settings.retention.targetRatio && !/^(paused|stopped)/.test(torrent.state)) {
            await backend.setRunning(hash, false, signal);
          } else if (torrent.progress === 1 && torrent.ratio < settings.retention.targetRatio && /^(paused|stopped)/.test(torrent.state)) {
            await backend.setRunning(hash, true, signal);
          }
        }
      });
      if (!live.has(hash)) continue;
      const removed = await deleteManaged(deps.downloads, backend, hash, signal,
        (record, torrent) => isExpired(record, torrent, settings, now()), active);
      if (removed) { result.deleted.push(hash); live.delete(hash); }
    } catch {
      result.failed.push(hash);
    }
  }
  if (result.failed.length === deps.downloads.list().length && result.failed.length && !live.size) result.skipped = 'download_backend_unreachable';
  if (settings.retention.maxCacheGB > 0) {
    let total = [...live.values()].reduce((sum, t) => sum + t.bytes, 0);
    const candidates = deps.downloads.list().sort((a,b) => a.expiresAt - b.expiresAt);
    for (const snapshot of candidates) {
      if (total <= settings.retention.maxCacheGB * 1e9) break;
      if (!live.has(snapshot.infoHash)) continue;
      try {
        const removed = await deleteManaged(deps.downloads, backend, snapshot.infoHash, signal,
          record => !record.kept && record.expiresAt === snapshot.expiresAt, active);
        if (removed) {
          result.evicted.push(snapshot.infoHash);
          total -= live.get(snapshot.infoHash)!.bytes;
        }
      } catch { if (!result.failed.includes(snapshot.infoHash)) result.failed.push(snapshot.infoHash); }
    }
  }
  return result;
}
