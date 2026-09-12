import { legacyBackendId, type DelugeBackendSettings } from '../../backends/config.js';
import type { BackendOwnership, DownloadBackend, DownloadCapabilities, DownloadFile, DownloadSnapshot, DownloadSource } from '../../backends/download.js';
import { ConnectionError, checkConnection, smallText, validVersion } from '../http.js';
import { objectRecord } from '../../json.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../../timeouts.js';

const BODY_LIMIT = 8 * 1024 * 1024;
const SESSION_CACHE_MS = 10_000;
// Deluge's Label plugin allows one label per torrent and only [a-z0-9_-].
// Scope is the first segment (qBittorrent category / Transmission labels[0]);
// further segments are ownership markers. Both submit() and addMarker()
// preserve that layout.
const LABEL_SEP = '__';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function encodeLabel(scope: string, markers: string[]): string {
  return [scope, ...markers].join(LABEL_SEP).toLowerCase();
}

function decodeLabel(label: string): { scope: string; markers: string[] } {
  if (!label) return { scope: '', markers: [] };
  const parts = label.split(LABEL_SEP);
  return { scope: parts[0] ?? '', markers: parts.slice(1).filter(Boolean) };
}

function jsonEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/json') ? trimmed : `${trimmed}/json`;
}

function toTorrent(id: string, raw: Record<string, unknown>): DownloadSnapshot {
  const { scope, markers } = decodeLabel(text(raw.label));
  // Deluge reports progress as a percentage (0–100).
  const progress = Math.min(1, Math.max(0, num(raw.progress) / 100));
  const savePath = text(raw.save_path) || text(raw.download_location);
  const moveCompleted = raw.move_completed === true;
  const incompleteDir = moveCompleted ? (text(raw.download_location) || savePath) : '';
  const totalSeeds = num(raw.total_seeds);
  const totalPeers = num(raw.total_peers);
  return {
    infoHash: id.toLowerCase(),
    scope,
    markers,
    name: text(raw.name),
    state: text(raw.state).toLowerCase() || 'unknown',
    progress,
    bytes: num(raw.total_size),
    ratio: num(raw.ratio),
    savePath,
    contentPath: savePath,
    ...(progress < 1 && incompleteDir && incompleteDir !== savePath ? { incompletePath: incompleteDir } : {}),
    bytesRemaining: num(raw.total_remaining) || Math.max(0, num(raw.total_wanted) - num(raw.total_wanted_done)),
    seeders: totalSeeds || num(raw.num_seeds),
    leechers: Math.max(0, (totalPeers || num(raw.num_peers)) - (totalSeeds || num(raw.num_seeds))),
    downloadSpeed: num(raw.download_payload_rate),
    eta: num(raw.eta),
    sequentialDownload: raw.sequential_download === true,
    firstLastPieces: raw.prioritize_first_last_pieces === true || raw.prioritize_first_last === true,
  };
}

const TORRENT_KEYS = [
  'name', 'state', 'progress', 'total_size', 'ratio', 'save_path', 'download_location',
  'total_remaining', 'total_wanted', 'total_wanted_done', 'num_seeds', 'num_peers',
  'total_seeds', 'total_peers', 'download_payload_rate', 'eta', 'label',
  'sequential_download', 'prioritize_first_last_pieces', 'move_completed', 'move_completed_path',
  'hash',
];

// Deluge Web JSON-RPC client: cookie auth, optional daemon connect, and the
// torrent operations core code needs through `DownloadBackend`.
export class DelugeClient implements DownloadBackend {
  private cookie = '';
  private connected = false;
  private labelReady = false;
  private rpcId = 1;
  private configCache?: { at: number; downloadDir: string };
  private readonly settings: DelugeBackendSettings;

  constructor(settings: Omit<DelugeBackendSettings, 'id' | 'type' | 'protocol' | 'pathMappings'> & Partial<Pick<DelugeBackendSettings, 'id' | 'type' | 'pathMappings'>>) {
    this.settings = {
      ...settings,
      id: settings.id ?? legacyBackendId(settings.url),
      type: 'deluge',
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
    downloadOrder: {
      sequential: (infoHash: string, signal: AbortSignal) => this.setSequential(infoHash, signal),
      firstLastPieces: (infoHash: string, signal: AbortSignal) => this.setFirstLastPieces(infoHash, signal),
    },
  };

  get identity(): string { return this.settings.id; }
  get pathMappings() { return this.settings.pathMappings; }
  get configured(): boolean { return Boolean(this.settings.url && this.settings.password); }

  private get endpoint(): string {
    return jsonEndpoint(this.settings.url);
  }

  private async login(signal: AbortSignal): Promise<void> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const response = await this.post('auth.login', [this.settings.password], signal, false);
    const parsed = await this.readRpc(response);
    if (parsed.error) throw new ConnectionError('authentication');
    if (parsed.result !== true) throw new ConnectionError('authentication');
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]!).find(value => value.startsWith('_session_id='));
    if (!cookie) throw new ConnectionError('authentication');
    this.cookie = cookie;
    this.connected = false;
    this.labelReady = false;
  }

  private async ensureSession(signal: AbortSignal): Promise<void> {
    if (!this.cookie) await this.login(signal);
    if (this.connected) return;
    const connected = await this.call<boolean>('web.connected', [], signal);
    if (connected === true) {
      this.connected = true;
      return;
    }
    const hosts = await this.call<unknown>('web.get_hosts', [], signal);
    if (!Array.isArray(hosts) || hosts.length === 0) throw new ConnectionError('unexpected_response');
    const first = hosts[0];
    const hostId = Array.isArray(first) ? first[0] : undefined;
    if (typeof hostId !== 'string' || !hostId) throw new ConnectionError('unexpected_response');
    await this.call('web.connect', [hostId], signal);
    this.connected = true;
  }

  private async post(method: string, params: unknown[], signal: AbortSignal, withCookie: boolean): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (withCookie && this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params, id: this.rpcId++ }),
      signal,
      redirect: 'manual',
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ConnectionError('authentication');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ConnectionError('unexpected_response');
    }
    return response;
  }

  private async readRpc(response: Response): Promise<{ result: unknown; error: { code?: unknown; message?: unknown } | null }> {
    let parsed: unknown;
    try { parsed = JSON.parse(await smallText(response, BODY_LIMIT)); }
    catch { throw new ConnectionError('unexpected_response'); }
    const body = objectRecord(parsed);
    if (!body) throw new ConnectionError('unexpected_response');
    return { result: body.result, error: objectRecord(body.error) ?? null };
  }

  private async call<T = unknown>(method: string, params: unknown[], signal: AbortSignal): Promise<T> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const send = async (): Promise<{ result: unknown; error: { code?: unknown; message?: unknown } | null }> => {
      const response = await this.post(method, params, signal, true);
      return this.readRpc(response);
    };
    let body = await send();
    const unauthenticated = (error: { code?: unknown } | null) => error !== null && (error.code === 1 || error.code === 2);
    if (unauthenticated(body.error)) {
      this.cookie = '';
      this.connected = false;
      await this.login(signal);
      await this.ensureSession(signal);
      body = await send();
    }
    if (body.error) throw new ConnectionError('unexpected_response');
    return body.result as T;
  }

  private async rpc<T = unknown>(method: string, params: unknown[], signal: AbortSignal): Promise<T> {
    await this.ensureSession(signal);
    return this.call<T>(method, params, signal);
  }

  async version(signal: AbortSignal): Promise<string> {
    const version = await this.rpc<unknown>('daemon.info', [], signal);
    if (!validVersion(version)) throw new ConnectionError('unexpected_response');
    return version;
  }

  test(timeoutMs = CONNECTION_TEST_TIMEOUT_MS) { return checkConnection(signal => this.version(signal), timeoutMs); }

  private async downloadDir(signal: AbortSignal): Promise<string> {
    if (this.configCache && Date.now() - this.configCache.at < SESSION_CACHE_MS) return this.configCache.downloadDir;
    const config = objectRecord(await this.rpc('core.get_config', [], signal));
    if (!config) throw new ConnectionError('unexpected_response');
    const downloadDir = text(config.download_location);
    this.configCache = { at: Date.now(), downloadDir };
    return downloadDir;
  }

  async freeSpace(signal: AbortSignal): Promise<number> {
    const path = await this.downloadDir(signal);
    const free = await this.rpc<unknown>('core.get_free_space', path ? [path] : [], signal);
    if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) throw new ConnectionError('unexpected_response');
    return free;
  }

  async get(infoHash: string, signal: AbortSignal): Promise<DownloadSnapshot | undefined> {
    const id = infoHash.toLowerCase();
    const status = objectRecord(await this.rpc('core.get_torrent_status', [id, TORRENT_KEYS], signal));
    if (!status) return undefined;
    if (!text(status.name) && !text(status.hash) && !text(status.state)) return undefined;
    return toTorrent(id, status);
  }

  async list(scope: string, signal: AbortSignal): Promise<DownloadSnapshot[]> {
    const raw = objectRecord(await this.rpc('core.get_torrents_status', [{}, TORRENT_KEYS], signal));
    if (!raw) throw new ConnectionError('unexpected_response');
    const entries: DownloadSnapshot[] = [];
    for (const [id, status] of Object.entries(raw)) {
      const snapshotStatus = objectRecord(status);
      if (!snapshotStatus) continue;
      const snapshot = toTorrent(id, snapshotStatus);
      if (snapshot.scope === scope) entries.push(snapshot);
    }
    return entries;
  }

  async getFiles(infoHash: string, signal: AbortSignal): Promise<DownloadFile[]> {
    let raw: unknown;
    try {
      raw = await this.rpc('core.get_torrent_status', [infoHash.toLowerCase(), ['files', 'file_progress', 'file_priorities']], signal);
    } catch (error) {
      // Metadata has not arrived yet; that is "no files known", not a fault.
      if (error instanceof ConnectionError && error.code === 'unexpected_response') return [];
      throw error;
    }
    const status = objectRecord(raw);
    if (!status) return [];
    const files = Array.isArray(status.files) ? status.files : [];
    const progress = Array.isArray(status.file_progress) ? status.file_progress : [];
    const priorities = Array.isArray(status.file_priorities) ? status.file_priorities : [];
    return files.map((file, index): DownloadFile => {
      const f = objectRecord(file) ?? {};
      const id = typeof f.index === 'number' ? f.index : index;
      return {
        id,
        path: text(f.path) || text(f.name),
        bytes: num(f.size),
        progress: num(progress[id] ?? progress[index]),
        selected: num(priorities[id] ?? priorities[index] ?? 1) > 0,
      };
    });
  }

  async pieceSize(infoHash: string, signal: AbortSignal): Promise<number> {
    const raw = objectRecord(await this.rpc('core.get_torrent_status', [infoHash.toLowerCase(), ['piece_length']], signal));
    const size = raw?.piece_length;
    if (!Number.isSafeInteger(size) || (size as number) <= 0) throw new ConnectionError('unexpected_response');
    return size as number;
  }

  async pieceStates(infoHash: string, signal: AbortSignal): Promise<number[]> {
    const raw = objectRecord(await this.rpc('core.get_torrent_status', [infoHash.toLowerCase(), ['pieces']], signal));
    const pieces = raw?.pieces;
    if (!Array.isArray(pieces) || !pieces.length) throw new ConnectionError('unexpected_response');
    return pieces.map((piece): number => {
      if (piece === true || piece === 2) return 2;
      if (piece === 1) return 1;
      return 0;
    });
  }

  async submit(source: DownloadSource, options: { ownership: BackendOwnership; stopped?: boolean }, signal: AbortSignal): Promise<void> {
    const addOptions = {
      add_paused: options.stopped === true,
      sequential_download: true,
      prioritize_first_last_pieces: true,
    };
    let id: unknown;
    try {
      if (source.type === 'magnet') {
        id = await this.rpc('core.add_torrent_magnet', [source.magnet, addOptions], signal);
      } else if (source.type === 'torrent') {
        id = await this.rpc('core.add_torrent_file', ['release.torrent', Buffer.from(source.bytes).toString('base64'), addOptions], signal);
      } else {
        throw new ConnectionError('unexpected_response');
      }
    } catch (error) {
      const fromMagnet = source.type === 'magnet' ? source.magnet.match(/btih:([a-fA-F0-9]{40})/i)?.[1] : undefined;
      if (!fromMagnet) throw error;
      id = fromMagnet;
    }
    if (typeof id !== 'string' || !/^[a-fA-F0-9]{40}$/.test(id)) throw new ConnectionError('unexpected_response');
    await this.applyOwnership(id.toLowerCase(), options.ownership, signal);
  }

  async setFilesSelected(infoHash: string, ids: number[], selected: boolean, signal: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    const files = await this.getFiles(infoHash, signal);
    if (files.length === 0) return;
    const change = new Set(ids);
    const priorities = files.map(file => {
      if (change.has(file.id)) return selected ? 1 : 0;
      return file.selected ? 1 : 0;
    });
    await this.rpc('core.set_torrent_options', [[infoHash.toLowerCase()], { file_priorities: priorities }], signal);
  }

  async setShareLimits(infoHash: string, limits: { ratioLimit: number; seedingTimeLimit?: number }, signal: AbortSignal): Promise<void> {
    const unlimited = limits.ratioLimit < 0;
    await this.rpc('core.set_torrent_options', [[infoHash.toLowerCase()], {
      stop_at_ratio: unlimited ? false : true,
      stop_ratio: unlimited ? 0 : limits.ratioLimit,
    }], signal);
  }

  async setSequential(infoHash: string, signal: AbortSignal): Promise<void> {
    await this.rpc('core.set_torrent_options', [[infoHash.toLowerCase()], { sequential_download: true }], signal);
  }

  async setFirstLastPieces(infoHash: string, signal: AbortSignal): Promise<void> {
    await this.rpc('core.set_torrent_options', [[infoHash.toLowerCase()], { prioritize_first_last_pieces: true }], signal);
  }

  async remove(infoHash: string, deleteFiles: boolean, signal: AbortSignal): Promise<void> {
    await this.rpc('core.remove_torrent', [infoHash.toLowerCase(), deleteFiles], signal);
  }

  async addMarker(infoHash: string, marker: string, signal: AbortSignal): Promise<void> {
    const current = await this.get(infoHash, signal);
    const scope = current?.scope || '';
    const markers = current?.markers ?? [];
    if (markers.includes(marker)) return;
    await this.applyOwnership(infoHash.toLowerCase(), { backend: this.identity, scope, marker }, signal, [...markers, marker]);
  }

  async setRunning(infoHash: string, running: boolean, signal: AbortSignal): Promise<void> {
    await this.rpc(running ? 'core.resume_torrent' : 'core.pause_torrent', [[infoHash.toLowerCase()]], signal);
  }

  private async applyOwnership(infoHash: string, ownership: BackendOwnership, signal: AbortSignal, markers = [ownership.marker]): Promise<void> {
    await this.ensureLabelPlugin(signal);
    const label = encodeLabel(ownership.scope, markers);
    await this.ensureLabel(label, signal);
    await this.rpc('label.set_torrent', [infoHash, label], signal);
  }

  private async ensureLabelPlugin(signal: AbortSignal): Promise<void> {
    if (this.labelReady) return;
    const enabled = await this.rpc<unknown>('core.get_enabled_plugins', [], signal);
    const names = Array.isArray(enabled) ? enabled.filter((name): name is string => typeof name === 'string') : [];
    if (!names.includes('Label')) {
      await this.rpc('core.enable_plugin', ['Label'], signal);
    }
    this.labelReady = true;
  }

  private async ensureLabel(label: string, signal: AbortSignal): Promise<void> {
    const existing = await this.rpc<unknown>('label.get_labels', [], signal);
    const labels = Array.isArray(existing) ? existing.filter((name): name is string => typeof name === 'string') : [];
    if (labels.includes(label)) return;
    try {
      await this.rpc('label.add', [label], signal);
    } catch {
      // Creating a label that already exists is a race, not a fault.
    }
  }
}
