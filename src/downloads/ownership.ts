import { randomBytes } from 'node:crypto';
import type { QBittorrentClient, QbtTorrent } from '../integrations/qbittorrent/client.js';
import type { DownloadRecord, DownloadsStore } from './store.js';
import { ConflictError } from './coordinator.js';
export const ownershipTag = () => `debridarr-${randomBytes(16).toString('hex')}`;
export function isOwned(record: DownloadRecord, torrent: QbtTorrent, qbt: QBittorrentClient): boolean {
  return Boolean(record.owner && record.owner.client === qbt.identity && torrent.hash === record.infoHash
    && torrent.category === record.owner.category && torrent.tags.includes(record.owner.tag));
}
// Call only under the hash coordinator. Legacy records require positive file
// and category evidence before tagging; absent/moved torrents stay visible.
export async function verifyOwnership(record: DownloadRecord, torrent: QbtTorrent, qbt: QBittorrentClient, store: DownloadsStore, signal: AbortSignal): Promise<DownloadRecord> {
  if (!record.owner && ['debridarr', 'debridgerr'].includes(torrent.category) && record.fileName) {
    const files = await qbt.files(record.infoHash, signal);
    if (files.some(f => f.index === record.fileIndex && f.name === record.fileName && f.size === record.bytes)) {
      const owner = { client: qbt.identity, category: torrent.category, tag: ownershipTag() };
      await qbt.addTags(record.infoHash, owner.tag, signal);
      const confirmed = await qbt.torrent(record.infoHash, signal);
      if (confirmed && isOwned({ ...record, owner }, confirmed, qbt)) {
        record = await store.upsert({ ...record, owner, lifecycle: 'managed', selectedFiles: [{ index: record.fileIndex, name: record.fileName, bytes: record.bytes }] });
        return record;
      }
    }
  }
  if (!isOwned(record, torrent, qbt)) {
    await store.upsert({ ...record, lifecycle: 'conflict', failure: 'ownership_conflict' });
    throw new ConflictError();
  }
  return record;
}
