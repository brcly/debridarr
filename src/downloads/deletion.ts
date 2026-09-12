import type { DownloadBackend, DownloadSnapshot } from '../backends/download.js';
import type { DownloadRecord } from './store.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { coordinated, ConflictError } from './coordinator.js';
import { verifyOwnership } from './ownership.js';
import { isActive } from '../playback/active.js';
export async function deleteManaged(store: DownloadsRepository, backend: DownloadBackend, hash: string, signal: AbortSignal,
  eligible: (record: DownloadRecord, torrent: DownloadSnapshot) => boolean = () => true,
  active = isActive): Promise<boolean> {
  return coordinated(store, hash, async () => {
    let record = store.get(hash);
    if (!record) return false;
    if (active(hash)) throw new ConflictError('This title is currently being prepared or streamed.');
    if (record.owner && record.owner.backend !== backend.identity) throw new ConflictError();
    const torrent = await backend.get(hash, signal);
    if (!torrent) {
      if (!record.owner) throw new ConflictError('Legacy ownership could not be verified.');
      // A direct successful hash lookup confirms absence, including lost delete replies.
      await store.remove(hash);
      return true;
    }
    record = await verifyOwnership(record, torrent, backend, store, signal);
    // Read again after every await which could admit external updates.
    record = store.get(hash)!;
    if (active(hash) || !eligible(record, torrent)) return false;
    await store.upsert({ ...record, lifecycle: 'deleting' });
    await backend.remove(hash, true, signal);
    if (await backend.get(hash, signal)) throw new Error('The download backend has not confirmed deletion; the download remains tracked.');
    await store.remove(hash);
    return true;
  });
}
