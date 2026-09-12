import { legacyBackendId, type TransmissionBackendSettings } from '../../backends/config.js';
import type { BackendOwnership, DownloadBackend, DownloadCapabilities, DownloadFile, DownloadSnapshot, DownloadSource } from '../../backends/download.js';
import { ConnectionError, checkConnection, smallText, validVersion } from '../http.js';
import { objectRecord } from '../../json.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../../timeouts.js';

const BODY_LIMIT = 8 * 1024 * 1024;
// Transmission renames an in-progress file with this suffix by default
// (session preference "rename-partial-files", enabled unless disabled).
const INCOMPLETE_SUFFIX = '.part';
// Refresh cached session state (free space/incomplete dir) at most this often.
const SESSION_CACHE_MS = 10_000;

// TR_STATUS_* from the Transmission RPC spec, translated into the free-form
// state strings core code matches by regex (see downloads/manager.ts,
// retention/sweeper.ts, application/transfers.ts).
const STATUS_NAMES: Record<number, string> = {
  0: 'stopped',
  1: 'queuedForChecking',
  2: 'checking',
  3: 'queuedDL',
  4: 'downloading',
  5: 'queuedUP',
  6: 'seeding',
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function labels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

interface RawTorrent {
  hashString?: unknown;
  name?: unknown;
  status?: unknown;
  percentDone?: unknown;
  totalSize?: unknown;
  uploadRatio?: unknown;
  downloadDir?: unknown;
  leftUntilDone?: unknown;
  rateDownload?: unknown;
  eta?: unknown;
  labels?: unknown;
  trackerStats?: unknown;
  pieceSize?: unknown;
  pieceCount?: unknown;
  pieces?: unknown;
  files?: unknown;
  fileStats?: unknown;
}

// This adapter's ownership convention: labels[0] is always the scope (the
// value passed as `ownership.scope`); any further labels are markers. Both
// submit() and addMarker() preserve that layout.
function toTorrent(raw: RawTorrent): DownloadSnapshot | undefined {
  if (typeof raw.hashString !== 'string') return undefined;
  const all = labels(raw.labels);
  let seeders = 0, leechers = 0;
  if (Array.isArray(raw.trackerStats)) {
    for (const entry of raw.trackerStats) {
      const t = objectRecord(entry) ?? {};
      if (typeof t.seederCount === 'number' && t.seederCount > 0) seeders += t.seederCount;
      if (typeof t.leecherCount === 'number' && t.leecherCount > 0) leechers += t.leecherCount;
    }
  }
  return {
    infoHash: raw.hashString.toLowerCase(),
    scope: all[0] ?? '',
    markers: all.slice(1),
    name: text(raw.name),
    state: STATUS_NAMES[num(raw.status)] ?? 'unknown',
    progress: num(raw.percentDone),
    bytes: num(raw.totalSize),
    ratio: num(raw.uploadRatio),
    savePath: text(raw.downloadDir),
    contentPath: text(raw.downloadDir),
    bytesRemaining: num(raw.leftUntilDone),
    seeders,
    leechers,
    downloadSpeed: num(raw.rateDownload),
    eta: num(raw.eta),
  };
}

function pieceStatesFromBitfield(base64: string, pieceCount: number): number[] {
  const bytes = Buffer.from(base64, 'base64');
  const states: number[] = [];
  for (let i = 0; i < pieceCount; i++) {
    const byte = bytes[i >> 3] ?? 0;
    const bit = (byte >> (7 - (i % 8))) & 1;
    states.push(bit ? 2 : 0);
  }
  return states;
}

// Transmission RPC client: CSRF session-id negotiation, JSON method calls,
// and the torrent operations core code needs through `DownloadBackend`.
export class TransmissionClient implements DownloadBackend {
  private sessionId = '';
  private sessionCache?: { at: number; downloadDir: string; incompleteDir?: string; version: string };
  private readonly settings: TransmissionBackendSettings;

  constructor(settings: Omit<TransmissionBackendSettings, 'id' | 'type' | 'protocol' | 'pathMappings'> & Partial<Pick<TransmissionBackendSettings, 'id' | 'type' | 'pathMappings'>>) {
    this.settings = {
      ...settings,
      id: settings.id ?? legacyBackendId(settings.url),
      type: 'transmission',
      protocol: 'torrent',
      pathMappings: settings.pathMappings ?? [],
    };
  }

  readonly protocol = 'torrent' as const;

  readonly capabilities: DownloadCapabilities = {
    freeSpace: (signal: AbortSignal) => this.freeSpace(signal),
    markers: { add: (infoHash: string, marker: string, signal: AbortSignal) => this.addMarker(infoHash, marker, signal) },
    pieces: {
      size: (infoHash: string, signal: AbortSignal) => this.pieceSize(infoHash, signal),
      states: (infoHash: string, signal: AbortSignal) => this.pieceStates(infoHash, signal),
    },
    seedLimits: (infoHash: string, limits: { ratioLimit: number; seedingTimeLimit?: number }, signal: AbortSignal) => this.setShareLimits(infoHash, limits, signal),
  };

  get identity(): string { return this.settings.id; }
  get pathMappings() { return this.settings.pathMappings; }
  get configured(): boolean { return Boolean(this.settings.url); }

  // POST one JSON-RPC method, negotiating the X-Transmission-Session-Id CSRF
  // token: an unrecognized or missing token yields 409 with the current token
  // in a response header; retry exactly once with it attached.
  private async rpc(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const body = JSON.stringify({ method, arguments: args });
    const attempt = async (): Promise<Record<string, unknown> | undefined> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.sessionId) headers['X-Transmission-Session-Id'] = this.sessionId;
      if (this.settings.username || this.settings.password) {
        headers.Authorization = `Basic ${Buffer.from(`${this.settings.username}:${this.settings.password}`).toString('base64')}`;
      }
      const response = await fetch(this.settings.url, { method: 'POST', headers, body, signal, redirect: 'manual' });
      if (response.status === 409) {
        const csrf = response.headers.get('x-transmission-session-id');
        await response.body?.cancel();
        if (!csrf) throw new ConnectionError('unexpected_response');
        this.sessionId = csrf;
        return undefined;
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ConnectionError('authentication'); }
      if (!response.ok) { await response.body?.cancel(); throw new ConnectionError('unexpected_response'); }
      let parsed: unknown;
      try { parsed = JSON.parse(await smallText(response, BODY_LIMIT)); }
      catch { throw new ConnectionError('unexpected_response'); }
      const result = objectRecord(parsed);
      if (!result || result.result !== 'success') throw new ConnectionError('unexpected_response');
      return objectRecord(result.arguments) ?? {};
    };
    const first = await attempt();
    if (first) return first;
    const second = await attempt();
    if (!second) throw new ConnectionError('unexpected_response');
    return second;
  }

  // session-get backs version(), freeSpace(), and the incomplete-dir hint used
  // when resolving in-progress files; cache briefly to avoid a call per torrent.
  private async session(signal: AbortSignal): Promise<{ downloadDir: string; incompleteDir?: string; version: string }> {
    if (this.sessionCache && Date.now() - this.sessionCache.at < SESSION_CACHE_MS) return this.sessionCache;
    const args = await this.rpc('session-get', {}, signal);
    const version = args.version;
    if (!validVersion(version)) throw new ConnectionError('unexpected_response');
    const cache = {
      at: Date.now(),
      downloadDir: text(args['download-dir']),
      version: version as string,
      ...(args['incomplete-dir-enabled'] === true ? { incompleteDir: text(args['incomplete-dir']) } : {}),
    };
    this.sessionCache = cache;
    return cache;
  }

  async version(signal: AbortSignal): Promise<string> {
    return (await this.session(signal)).version;
  }

  test(timeoutMs = CONNECTION_TEST_TIMEOUT_MS) { return checkConnection(signal => this.version(signal), timeoutMs); }

  async freeSpace(signal: AbortSignal): Promise<number> {
    const { downloadDir } = await this.session(signal);
    const args = await this.rpc('free-space', { path: downloadDir }, signal);
    const free = args['size-bytes'];
    if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) throw new ConnectionError('unexpected_response');
    return free;
  }

  private readonly torrentFields = [
    'hashString', 'name', 'status', 'percentDone', 'totalSize', 'uploadRatio', 'downloadDir',
    'leftUntilDone', 'rateDownload', 'eta', 'labels', 'trackerStats',
  ];

  private withIncompletePath(snapshot: DownloadSnapshot, incompleteDir: string | undefined): DownloadSnapshot {
    return snapshot.progress < 1 && incompleteDir ? { ...snapshot, incompletePath: incompleteDir } : snapshot;
  }

  async get(infoHash: string, signal: AbortSignal): Promise<DownloadSnapshot | undefined> {
    const [args, { incompleteDir }] = await Promise.all([
      this.rpc('torrent-get', { ids: [infoHash], fields: this.torrentFields }, signal),
      this.session(signal),
    ]);
    const list = args.torrents;
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    const found = list.map(toTorrent).find((entry): entry is DownloadSnapshot => entry?.infoHash === infoHash.toLowerCase());
    return found && this.withIncompletePath(found, incompleteDir);
  }

  async list(scope: string, signal: AbortSignal): Promise<DownloadSnapshot[]> {
    const [args, { incompleteDir }] = await Promise.all([
      this.rpc('torrent-get', { fields: this.torrentFields }, signal),
      this.session(signal),
    ]);
    const list = args.torrents;
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    return list.map(toTorrent)
      .filter((entry): entry is DownloadSnapshot => entry !== undefined && entry.scope === scope)
      .map(entry => this.withIncompletePath(entry, incompleteDir));
  }

  async getFiles(infoHash: string, signal: AbortSignal): Promise<DownloadFile[]> {
    const args = await this.rpc('torrent-get', { ids: [infoHash], fields: ['files', 'fileStats'] }, signal);
    const torrents = args.torrents;
    if (!Array.isArray(torrents) || torrents.length === 0) return [];
    const raw = torrents[0] as RawTorrent;
    const files = Array.isArray(raw.files) ? raw.files : [];
    const stats = Array.isArray(raw.fileStats) ? raw.fileStats : [];
    return files.map((file, index): DownloadFile => {
      const f = objectRecord(file) ?? {};
      const s = objectRecord(stats[index]) ?? {};
      return {
        id: index,
        path: text(f.name),
        bytes: num(f.length),
        progress: num(f.length) > 0 ? num(f.bytesCompleted) / num(f.length) : 0,
        selected: s.wanted !== false,
        incompleteSuffixes: [INCOMPLETE_SUFFIX],
      };
    });
  }

  async pieceSize(infoHash: string, signal: AbortSignal): Promise<number> {
    const args = await this.rpc('torrent-get', { ids: [infoHash], fields: ['pieceSize'] }, signal);
    const torrents = args.torrents;
    const size = Array.isArray(torrents) ? (torrents[0] as RawTorrent | undefined)?.pieceSize : undefined;
    if (!Number.isSafeInteger(size) || (size as number) <= 0) throw new ConnectionError('unexpected_response');
    return size as number;
  }

  async pieceStates(infoHash: string, signal: AbortSignal): Promise<number[]> {
    const args = await this.rpc('torrent-get', { ids: [infoHash], fields: ['pieceCount', 'pieces'] }, signal);
    const torrents = args.torrents;
    const raw = Array.isArray(torrents) ? (torrents[0] as RawTorrent | undefined) : undefined;
    const count = raw?.pieceCount;
    const bitfield = raw?.pieces;
    if (!Number.isSafeInteger(count) || (count as number) <= 0 || typeof bitfield !== 'string') {
      throw new ConnectionError('unexpected_response');
    }
    return pieceStatesFromBitfield(bitfield, count as number);
  }

  async submit(source: DownloadSource, options: { ownership: BackendOwnership; stopped?: boolean }, signal: AbortSignal): Promise<void> {
    const args: Record<string, unknown> = {
      paused: options.stopped ? true : false,
      labels: [options.ownership.scope, options.ownership.marker],
    };
    if (source.type === 'magnet') args.filename = source.magnet;
    else if (source.type === 'torrent') args.metainfo = Buffer.from(source.bytes).toString('base64');
    else throw new ConnectionError('unexpected_response');
    const result = await this.rpc('torrent-add', args, signal);
    const added = (result['torrent-added'] ?? result['torrent-duplicate']) as { id?: unknown } | undefined;
    if (!added || typeof added.id !== 'number') throw new ConnectionError('unexpected_response');
    // A duplicate response means the torrent already exists; (re)apply labels
    // so ownership is idempotent regardless of which branch fired.
    await this.rpc('torrent-set', { ids: [added.id], labels: [options.ownership.scope, options.ownership.marker] }, signal);
  }

  async setFilesSelected(infoHash: string, ids: number[], selected: boolean, signal: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    await this.rpc('torrent-set', { ids: [infoHash], [selected ? 'files-wanted' : 'files-unwanted']: ids }, signal);
  }

  async setShareLimits(infoHash: string, limits: { ratioLimit: number; seedingTimeLimit?: number }, signal: AbortSignal): Promise<void> {
    const args: Record<string, unknown> = {
      ids: [infoHash],
      seedRatioLimit: limits.ratioLimit,
      seedRatioMode: limits.ratioLimit >= 0 ? 1 : 2,
    };
    if (limits.seedingTimeLimit !== undefined) {
      args.seedIdleLimit = limits.seedingTimeLimit;
      args.seedIdleMode = limits.seedingTimeLimit >= 0 ? 1 : 2;
    }
    await this.rpc('torrent-set', args, signal);
  }

  async remove(infoHash: string, deleteFiles: boolean, signal: AbortSignal): Promise<void> {
    await this.rpc('torrent-remove', { ids: [infoHash], 'delete-local-data': deleteFiles }, signal);
  }

  async addMarker(infoHash: string, marker: string, signal: AbortSignal): Promise<void> {
    const args = await this.rpc('torrent-get', { ids: [infoHash], fields: ['labels'] }, signal);
    const torrents = args.torrents;
    const current = Array.isArray(torrents) ? labels((torrents[0] as RawTorrent | undefined)?.labels) : [];
    if (current.includes(marker)) return;
    await this.rpc('torrent-set', { ids: [infoHash], labels: [...current, marker] }, signal);
  }

  async setRunning(infoHash: string, running: boolean, signal: AbortSignal): Promise<void> {
    await this.rpc(running ? 'torrent-start' : 'torrent-stop', { ids: [infoHash] }, signal);
  }
}
