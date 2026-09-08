import type { QBittorrentClient, QbtTorrent } from '../integrations/qbittorrent/client.js';
import type { DownloadRecord, DownloadsStore } from './store.js';
import { coordinated, ConflictError } from './coordinator.js';
import { verifyOwnership } from './ownership.js';
import { isActive } from '../playback/active.js';
export async function deleteManaged(store: DownloadsStore, qbt: QBittorrentClient, hash: string, signal: AbortSignal,
  eligible: (record: DownloadRecord, torrent: QbtTorrent) => boolean = () => true,
  active = isActive): Promise<boolean> {
  return coordinated(store, hash, async () => {
    let record = store.get(hash);
    if (!record) return false;
    if (active(hash)) throw new ConflictError('This title is currently being prepared or streamed.');
    if (record.owner && record.owner.client !== qbt.identity) throw new ConflictError();
    const torrent = await qbt.torrent(hash, signal);
    if (!torrent) {
      if (!record.owner) throw new ConflictError('Legacy ownership could not be verified.');
      // A direct successful hash lookup confirms absence, including lost delete replies.
      await store.remove(hash);
      return true;
    }
    record = await verifyOwnership(record, torrent, qbt, store, signal);
    // Read again after every await which could admit external updates.
    record = store.get(hash)!;
    if (active(hash) || !eligible(record, torrent)) return false;
    await store.upsert({ ...record, lifecycle: 'deleting' });
    await qbt.delete(hash, true, signal);
    if (await qbt.torrent(hash, signal)) throw new Error('qBittorrent has not confirmed deletion; the download remains tracked.');
    await store.remove(hash);
    return true;
  });
}
