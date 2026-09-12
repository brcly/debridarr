import type { Release } from '../discovery/source.js';
import type { MediaId } from '../metadata/id.js';
import { isPrepareTransferRequest, type PrepareTransferRequest, type TransferMedia, type TransferSource } from '../application/types.js';

// A playback reference must fit well under the addon store's per-entry cap.
const MAX_REFERENCE_BYTES = 16384;

export function mediaOf(id: MediaId): TransferMedia {
  return {
    imdbId: id.imdbId, type: id.type,
    ...(id.season === undefined ? {} : { season: id.season }),
    ...(id.episode === undefined ? {} : { episode: id.episode }),
  };
}

// Shared by search playback and RSS saved searches: a release becomes
// whatever `TransferSource` its links actually support, or undefined when it
// has none usable. A `magnetUrl` that is actually an HTTP link (some indexers
// do this) is a download URL, resolved with the matching provider's
// credentials at play/poll time.
export function releaseSource(release: Release): TransferSource | undefined {
  const httpUrl = release.downloadUrl ?? (release.magnetUrl?.startsWith('http') ? release.magnetUrl : undefined);
  return httpUrl ? { downloadUrl: httpUrl }
    : release.magnetUrl?.startsWith('magnet:') ? { magnet: release.magnetUrl }
    : release.infoHash ? { infoHash: release.infoHash.toLowerCase() }
    : undefined;
}

// A ranked indexer result becomes a backend-neutral prepare request. Returns
// undefined when the release has no usable source or would not fit a
// reference — the search layer treats that as "unusable" so it does not
// consume a result slot.
export function releaseRequest(release: Release, id: MediaId): PrepareTransferRequest | undefined {
  const source = releaseSource(release);
  if (!source) return undefined;
  const request: PrepareTransferRequest = { source, origin: 'search', name: release.title, bytes: release.size, media: mediaOf(id) };
  return isPrepareTransferRequest(request) && Buffer.byteLength(JSON.stringify(request)) <= MAX_REFERENCE_BYTES ? request : undefined;
}
