// Compatibility surface for the torrent-era names. The canonical,
// protocol-neutral contract lives in download.ts; these aliases keep existing
// call sites and tests compiling while Stage 7 migrates them (Usenet shapes
// land in 7.3/7.4, which is also when the snapshot/file names get unified).
import type { DownloadBackend, DownloadCapabilities, DownloadFile, DownloadSnapshot, DownloadSource } from './download.js';

export type {
  BackendConnection, BackendOwnership, DownloadBackend, DownloadCapabilities, DownloadFile,
  DownloadProtocol, DownloadSnapshot, DownloadSource,
} from './download.js';

export type TorrentBackend = DownloadBackend;
export type TorrentBackendFeatures = DownloadCapabilities;
export type TorrentSnapshot = DownloadSnapshot;
export type TorrentFile = DownloadFile;
export type TorrentSource = DownloadSource;
