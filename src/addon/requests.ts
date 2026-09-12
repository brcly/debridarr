import type { DownloadRecord } from '../downloads/store.js';
import type { PrepareTransferRequest, TransferMedia } from '../application/types.js';

export { mediaOf, releaseRequest } from '../search/requests.js';

// A downloaded copy pinned to one owned file: play it, never re-add the torrent.
export function cachedCopyRequest(
  record: DownloadRecord,
  file: { index: number; name: string; bytes: number },
  media: TransferMedia,
): PrepareTransferRequest {
  return {
    source: { infoHash: record.infoHash },
    origin: record.origin,
    name: record.name,
    bytes: file.bytes,
    media,
    selection: {
      file: { id: file.index, path: file.name, bytes: file.bytes, marker: record.owner!.marker },
      behavior: 'require-existing',
    },
  };
}
