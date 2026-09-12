import { randomBytes } from 'node:crypto';
import type { DownloadBackend, DownloadSnapshot } from '../backends/download.js';
import type { DownloadRecord } from './store.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { ConflictError } from './coordinator.js';
export const ownershipTag = () => `debridarr-${randomBytes(16).toString('hex')}`;
export function isOwned(record: DownloadRecord, torrent: DownloadSnapshot, backend: DownloadBackend): boolean {
  return Boolean(record.owner && record.owner.backend === backend.identity && torrent.infoHash === record.infoHash
    && torrent.scope === record.owner.scope && torrent.markers.includes(record.owner.marker));
}
// Call only under the hash coordinator. Legacy records require positive file
// and category evidence before tagging; absent/moved torrents stay visible.
export async function verifyOwnership(record: DownloadRecord, torrent: DownloadSnapshot, backend: DownloadBackend, store: DownloadsRepository, signal: AbortSignal): Promise<DownloadRecord> {
  if (!record.owner && ['debridarr', 'debridgerr'].includes(torrent.scope) && record.fileName) {
    const files = await backend.getFiles(record.infoHash, signal);
    // Adoption needs a durable marker; a backend without the marker
    // capability can never prove ownership, so its jobs are never adopted.
    const markers = backend.capabilities.markers;
    if (markers && files.some(f => f.id === record.fileIndex && f.path === record.fileName && f.bytes === record.bytes)) {
      const owner = { backend: backend.identity, scope: torrent.scope, marker: ownershipTag() };
      await markers.add(record.infoHash, owner.marker, signal);
      const confirmed = await backend.get(record.infoHash, signal);
      if (confirmed && isOwned({ ...record, owner }, confirmed, backend)) {
        record = await store.upsert({ ...record, owner, lifecycle: 'managed', selectedFiles: [{ index: record.fileIndex, name: record.fileName, bytes: record.bytes }] });
        return record;
      }
    }
  }
  if (!isOwned(record, torrent, backend)) {
    await store.upsert({ ...record, lifecycle: 'conflict', failure: 'ownership_conflict' });
    throw new ConflictError();
  }
  return record;
}
