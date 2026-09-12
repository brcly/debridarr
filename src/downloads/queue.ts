import type { TransferSource, TransferSourceResolver } from '../application/types.js';
import type { DownloadBackend } from '../backends/download.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { BusyError } from '../security/admission.js';
import { DownloadError, ensureTransfer } from './manager.js';
import type { QueuedSource } from './store.js';
import { isQueuedSource } from './store.js';
import { TRANSFER_SUBMIT_TIMEOUT_MS } from '../timeouts.js';

export function fromQueuedSource(source: QueuedSource): TransferSource {
  if ('infoHash' in source) return { infoHash: source.infoHash.toLowerCase() };
  if ('magnet' in source) return { magnet: source.magnet };
  if ('torrent' in source) return { torrent: Buffer.from(source.torrent, 'base64') };
  if ('nzb' in source) return { nzb: Buffer.from(source.nzb, 'base64') };
  return { downloadUrl: source.downloadUrl };
}

export async function admitQueuedTransfers(deps: {
  downloads: DownloadsRepository;
  backend: DownloadBackend;
  leaseDays: number;
  maxActiveDownloads: number;
  minFreeSpaceGB: number;
  sourceResolver?: TransferSourceResolver;
}): Promise<boolean> {
  const next = deps.downloads.list()
    .filter(r => r.origin === 'store' && r.lifecycle === 'queued' && isQueuedSource(r.queuedSource))
    .sort((a, b) => a.addedAt - b.addedAt || (a.infoHash < b.infoHash ? -1 : a.infoHash > b.infoHash ? 1 : 0))[0];
  if (!next?.queuedSource || !deps.backend.configured) return false;
  try {
    await ensureTransfer({
      source: fromQueuedSource(next.queuedSource),
      origin: 'store',
      name: next.name,
      bytes: next.bytes,
      ...(next.media ? { media: next.media } : {}),
    }, {
      backend: deps.backend, store: deps.downloads, signal: AbortSignal.timeout(TRANSFER_SUBMIT_TIMEOUT_MS),
      retentionDays: deps.leaseDays,
      storeMaxActiveDownloads: deps.maxActiveDownloads,
      minFreeSpaceGB: deps.minFreeSpaceGB,
      metadataTimeoutMs: 0,
      ...(deps.sourceResolver ? { sourceResolver: deps.sourceResolver } : {}),
    });
    return true;
  } catch (error) {
    if (error instanceof BusyError) return false;
    if (error instanceof DownloadError && (error.code === 'low_space' || error.code === 'space_unknown')) return false;
    return false;
  }
}
