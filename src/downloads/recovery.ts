import { DownloadError, ensureTransfer } from './manager.js';
import { admitQueuedTransfers } from './queue.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { createDownloadBackend } from '../backends/factory.js';
import type { DownloadBackend } from '../backends/download.js';
import type { Settings } from '../settings.js';
import type { SettingsRepository } from '../state/repositories.js';
import { BACKEND_ACTION_TIMEOUT_MS } from '../timeouts.js';

interface RecoveryDeps {
  store: SettingsRepository;
  downloads: DownloadsRepository;
  backendFactory?: (settings: Settings['downloadBackend']) => DownloadBackend;
  now?: () => number;
}

// Recovery only operates on existing torrents; an ambiguous lost add response
// must never result in an automatic re-add with missing tracker information.
export async function retryDownload(hash: string, deps: RecoveryDeps): Promise<{ pending: boolean }> {
  const record = deps.downloads.get(hash);
  if (!record || !['registering', 'managed'].includes(record.lifecycle ?? '')) {
    throw new DownloadError('cache_missing', 'This download cannot be retried. Check its status and download backend.');
  }
  const settings = deps.store.snapshot();
  const backend = (deps.backendFactory ?? createDownloadBackend)(settings.downloadBackend);
  const options = { backend, store: deps.downloads, signal: AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS), existingOnly: true, metadataTimeoutMs: 0,
    retentionDays: record.origin === 'store' ? settings.retention.storeLeaseDays : settings.retention.days,
    minFreeSpaceGB: settings.retention.minFreeSpaceGB, storeMaxActiveDownloads: settings.store.maxActiveDownloads };
  try {
    if (record.origin === 'store') await ensureTransfer({ source: { infoHash: hash }, origin: 'store', name: record.name, bytes: record.bytes, ...(record.media ? { media: record.media } : {}) }, options);
    else if (record.media) await ensureTransfer({ source: { infoHash: hash }, origin: 'search', name: record.name, bytes: record.bytes, media: record.media }, options);
    else throw new DownloadError('no_file', 'This search download has no media identity.');
    return { pending: false };
  } catch (error) {
    if (error instanceof DownloadError && error.code === 'no_metadata') return { pending: true };
    throw error;
  }
}

export class DownloadRecovery {
  private running = false;
  private attempts = new Map<string, { next: number; delay: number }>();
  private readonly deps: RecoveryDeps;
  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.deps.now ?? Date.now;
      const settings = this.deps.store.snapshot();
      const backend = (this.deps.backendFactory ?? createDownloadBackend)(settings.downloadBackend);
      await admitQueuedTransfers({
        downloads: this.deps.downloads, backend,
        leaseDays: settings.retention.storeLeaseDays,
        maxActiveDownloads: settings.store.maxActiveDownloads,
        minFreeSpaceGB: settings.retention.minFreeSpaceGB,
      });
      const pending = this.deps.downloads.list().filter(r => r.lifecycle === 'registering'
        || (r.lifecycle === 'managed' && r.failure === 'preparation_failed'));
      const hashes = new Set(pending.map(r => r.infoHash));
      for (const hash of this.attempts.keys()) if (!hashes.has(hash)) this.attempts.delete(hash);
      const due = pending.filter(r => (this.attempts.get(r.infoHash)?.next ?? 0) <= now())
        .sort((a, b) => (this.attempts.get(a.infoHash)?.next ?? 0) - (this.attempts.get(b.infoHash)?.next ?? 0));
      // Two short probes per tick, with a 15-second to 5-minute backoff per item.
      for (const record of due.slice(0, 2)) {
        try {
          if (!(await retryDownload(record.infoHash, this.deps)).pending) { this.attempts.delete(record.infoHash); continue; }
        } catch { /* Kept tracked; the dashboard exposes the current failure. */ }
        const delay = Math.min(300_000, (this.attempts.get(record.infoHash)?.delay ?? 7_500) * 2);
        this.attempts.set(record.infoHash, { next: now() + delay, delay });
      }
    } finally { this.running = false; }
  }
}
