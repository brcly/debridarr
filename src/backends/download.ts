// Protocol-neutral download backend contract. Torrent and Usenet clients both
// implement this lifecycle; anything protocol-specific (pieces, seed limits,
// download order, ownership markers) is declared as an optional capability
// group, so core branches on what a backend declares — never on its type or
// protocol string.
export type DownloadProtocol = 'torrent' | 'usenet';

export interface PathMapping {
  remote: string;
  local: string;
}

export interface BackendConnection {
  ok: boolean;
  code: 'connected' | 'not_configured' | 'authentication' | 'unreachable' | 'timeout' | 'unexpected_response';
  message: string;
  version?: string;
}

export interface BackendOwnership {
  backend: string;
  scope: string;
  marker: string;
}

export interface DownloadSnapshot {
  infoHash: string;
  scope: string;
  markers: string[];
  name: string;
  state: string;
  progress: number;
  bytes: number;
  ratio: number;
  savePath: string;
  contentPath: string;
  incompletePath?: string;
  bytesRemaining: number;
  seeders: number;
  leechers: number;
  downloadSpeed: number;
  eta: number;
  sequentialDownload?: boolean;
  firstLastPieces?: boolean;
}

export interface DownloadFile {
  id: number;
  path: string;
  bytes: number;
  progress: number;
  selected: boolean;
  pieceRange?: [number, number];
  incompleteSuffixes?: string[];
}

export type DownloadSource =
  | { type: 'magnet'; magnet: string }
  | { type: 'torrent'; bytes: Uint8Array }
  | { type: 'nzb'; bytes: Uint8Array };

// A group is present only when the backend genuinely implements it. Core
// must treat absence as "not supported" rather than assuming torrent
// semantics; a Usenet backend declares none of the torrent groups.
export interface DownloadCapabilities {
  freeSpace?: (signal: AbortSignal) => Promise<number>;
  markers?: {
    add: (infoHash: string, marker: string, signal: AbortSignal) => Promise<void>;
  };
  pieces?: {
    size: (infoHash: string, signal: AbortSignal) => Promise<number>;
    states: (infoHash: string, signal: AbortSignal) => Promise<number[]>;
  };
  seedLimits?: (infoHash: string, limits: { ratioLimit: number; seedingTimeLimit?: number }, signal: AbortSignal) => Promise<void>;
  downloadOrder?: {
    sequential: (infoHash: string, signal: AbortSignal) => Promise<void>;
    firstLastPieces: (infoHash: string, signal: AbortSignal) => Promise<void>;
  };
}

export interface DownloadBackend {
  readonly identity: string;
  readonly protocol: DownloadProtocol;
  readonly configured: boolean;
  readonly pathMappings: readonly PathMapping[];
  readonly capabilities: DownloadCapabilities;

  test(timeoutMs?: number): Promise<BackendConnection>;
  get(infoHash: string, signal: AbortSignal): Promise<DownloadSnapshot | undefined>;
  list(scope: string, signal: AbortSignal): Promise<DownloadSnapshot[]>;
  getFiles(infoHash: string, signal: AbortSignal): Promise<DownloadFile[]>;
  submit(source: DownloadSource, options: { ownership: BackendOwnership; stopped?: boolean }, signal: AbortSignal): Promise<void>;
  setFilesSelected(infoHash: string, ids: number[], selected: boolean, signal: AbortSignal): Promise<void>;
  remove(infoHash: string, deleteFiles: boolean, signal: AbortSignal): Promise<void>;
  // Pause/resume the job. Shared: both protocols have a running/stopped state.
  setRunning(infoHash: string, running: boolean, signal: AbortSignal): Promise<void>;
}
