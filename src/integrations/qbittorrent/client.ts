import { legacyBackendId, type QBittorrentBackendSettings } from '../../backends/config.js';
import type { BackendOwnership, DownloadBackend, DownloadCapabilities, DownloadFile, DownloadSnapshot, DownloadSource } from '../../backends/download.js';
import { checkConnection, ConnectionError, serviceFetch, smallText, validVersion } from '../http.js';
import { objectRecord } from '../../json.js';
import { log } from '../../log.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../../timeouts.js';

const BODY_LIMIT = 8 * 1024 * 1024;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toTorrent(raw: unknown): DownloadSnapshot | undefined {
  const r = objectRecord(raw);
  if (!r || typeof r.hash !== 'string') return undefined;
  return {
    infoHash: r.hash.toLowerCase(),
    scope: text(r.category),
    markers: text(r.tags).split(',').map(t => t.trim()).filter(Boolean),
    name: text(r.name),
    state: text(r.state),
    progress: num(r.progress),
    bytes: num(r.size),
    ratio: num(r.ratio),
    savePath: text(r.save_path),
    contentPath: text(r.content_path),
    incompletePath: text(r.download_path),
    bytesRemaining: num(r.amount_left),
    seeders: num(r.num_seeds),
    leechers: num(r.num_leechs),
    downloadSpeed: num(r.dlspeed),
    eta: num(r.eta),
    sequentialDownload: r.seq_dl === true,
    firstLastPieces: r.f_l_piece_prio === true,
  };
}

// Full qBittorrent Web API client: a shared session cookie, re-login on
// expiry, and the torrent operations `/play` and the retention sweeper need.
export class QBittorrentClient implements DownloadBackend {
  private cookie = '';
  // Set once login has established a working session, whether via a SID cookie
  // or qBittorrent's IP-address auth bypass (which issues no cookie).
  private authed = false;
  private readonly settings: QBittorrentBackendSettings;
  constructor(settings: Omit<QBittorrentBackendSettings, 'id' | 'type' | 'protocol' | 'pathMappings'> & Partial<Pick<QBittorrentBackendSettings, 'id' | 'type' | 'pathMappings'>>) {
    this.settings = {
      ...settings,
      id: settings.id ?? legacyBackendId(settings.url),
      type: 'qbittorrent',
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
      firstLastPieces: (infoHash: string, signal: AbortSignal) => this.setFirstLastPiecePriority(infoHash, signal),
    },
  };

  get identity(): string { return this.settings.id; }
  get pathMappings() { return this.settings.pathMappings; }

  get configured(): boolean {
    return Boolean(this.settings.url && this.settings.username && this.settings.password);
  }
  private get origin(): string {
    return new URL(this.settings.url).origin;
  }

  async login(signal: AbortSignal): Promise<void> {
    const { url, username, password } = this.settings;
    if (!url || !username || !password) throw new ConnectionError('not_configured');
    const response = await serviceFetch(`${url}/api/v2/auth/login`, signal, {
      method: 'POST', headers: { Origin: this.origin }, body: new URLSearchParams({ username, password }),
    });
    const body = (await smallText(response)).trim();
    if (body === 'Fails.') throw new ConnectionError('authentication');
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]!).find(value => /^SID=[\w-]+$/.test(value));
    if (body === 'Ok.') {
      // A normal login must hand back a session cookie.
      if (!cookie) throw new ConnectionError('authentication');
      this.cookie = cookie;
      this.authed = true;
      return;
    }
    // qBittorrent 5.1+ with "bypass authentication for clients on localhost / in
    // whitelisted IP subnets" authorises by source address: the login endpoint
    // returns 204 (or 200 with an empty body) and no SID cookie. Proceed without
    // a cookie; every later request is authorised the same way.
    if (response.status === 204 || body === '') {
      this.cookie = cookie ?? '';
      this.authed = true;
      return;
    }
    throw new ConnectionError('unexpected_response');
  }

  // GET/POST an API path with the session cookie, logging in first and retrying
  // once if the session has expired.
  private async api(path: string, signal: AbortSignal, form?: Record<string, string> | FormData): Promise<Response> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const send = async () => {
      if (!this.cookie && !this.authed) await this.login(signal);
      const headers: Record<string, string> = { Origin: this.origin };
      if (this.cookie) headers.Cookie = this.cookie;
      const init: RequestInit = { headers };
      if (form) {
        init.method = 'POST';
        init.body = form instanceof FormData ? form : new URLSearchParams(form);
      }
      return serviceFetch(`${this.settings.url}${path}`, signal, init);
    };
    try {
      return await send();
    } catch (error) {
      if (error instanceof ConnectionError && error.code === 'authentication') {
        this.cookie = '';
        this.authed = false;
        return send();
      }
      if (error instanceof ConnectionError) {
        log.warn(`Debridarr qBittorrent ${form ? 'POST' : 'GET'} ${path.split('?')[0]} -> ${error.status ?? '?'} (${error.code})`);
      }
      throw error;
    }
  }

  private async json(path: string, signal: AbortSignal, form?: Record<string, string>): Promise<unknown> {
    const response = await this.api(path, signal, form);
    try { return JSON.parse(await smallText(response, BODY_LIMIT)); }
    catch { throw new ConnectionError('unexpected_response'); }
  }

  // qBittorrent reports free space on its default download filesystem.
  async freeSpace(signal: AbortSignal): Promise<number> {
    const data = objectRecord(await this.json('/api/v2/sync/maindata?rid=0', signal));
    const free = objectRecord(data?.server_state)?.free_space_on_disk;
    if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) throw new ConnectionError('unexpected_response');
    return free;
  }

  async version(signal: AbortSignal): Promise<string> {
    const response = await this.api('/api/v2/app/version', signal);
    const version = (await smallText(response)).trim();
    if (!validVersion(version)) throw new ConnectionError('unexpected_response');
    return version;
  }

  test(timeoutMs = CONNECTION_TEST_TIMEOUT_MS) { return checkConnection(signal => this.version(signal), timeoutMs); }

  async get(infoHash: string, signal: AbortSignal): Promise<DownloadSnapshot | undefined> {
    const list = await this.json(`/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash)}`, signal);
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    return list.map(toTorrent).find((entry): entry is DownloadSnapshot => entry?.infoHash === infoHash.toLowerCase());
  }

  async list(scope: string, signal: AbortSignal): Promise<DownloadSnapshot[]> {
    const list = await this.json(`/api/v2/torrents/info?category=${encodeURIComponent(scope)}`, signal);
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    return list.map(toTorrent).filter((entry): entry is DownloadSnapshot => entry !== undefined);
  }

  async getFiles(infoHash: string, signal: AbortSignal): Promise<DownloadFile[]> {
    let list: unknown;
    try {
      list = await this.json(`/api/v2/torrents/files?hash=${encodeURIComponent(infoHash)}`, signal);
    } catch (error) {
      // qBittorrent answers 404 (or a non-JSON body) for a torrent whose
      // metadata has not arrived yet; that is "no files known", not a fault.
      if (error instanceof ConnectionError && error.code === 'unexpected_response') return [];
      throw error;
    }
    if (!Array.isArray(list)) return [];
    return list.map((raw, fallback): DownloadFile => {
      const r = objectRecord(raw) ?? {};
      return {
        id: typeof r.index === 'number' ? r.index : fallback,
        path: text(r.name),
        bytes: num(r.size),
        progress: num(r.progress),
        selected: num(r.priority) > 0,
        incompleteSuffixes: ['.!qB'],
        ...(Array.isArray(r.piece_range) && r.piece_range.length === 2
          && r.piece_range.every(v => Number.isSafeInteger(v) && v >= 0) && r.piece_range[1] >= r.piece_range[0]
          ? { pieceRange: r.piece_range as [number, number] } : {}),
      };
    });
  }

  async pieceSize(hash: string, signal: AbortSignal): Promise<number> {
    const properties = objectRecord(await this.json(`/api/v2/torrents/properties?hash=${encodeURIComponent(hash)}`, signal));
    const size = properties?.piece_size;
    if (!Number.isSafeInteger(size) || (size as number) <= 0) throw new ConnectionError('unexpected_response');
    return size as number;
  }

  async pieceStates(hash: string, signal: AbortSignal): Promise<number[]> {
    const states = await this.json(`/api/v2/torrents/pieceStates?hash=${encodeURIComponent(hash)}`, signal);
    if (!Array.isArray(states) || !states.length || !states.every(v => v === 0 || v === 1 || v === 2)) {
      throw new ConnectionError('unexpected_response');
    }
    return states as number[];
  }

  async submit(source: DownloadSource, options: { ownership: BackendOwnership; stopped?: boolean }, signal: AbortSignal): Promise<void> {
    const common = {
      category: options.ownership.scope,
      tags: options.ownership.marker,
      ratioLimit: '-1',
      seedingTimeLimit: '-1',
      inactiveSeedingTimeLimit: '-1',
      paused: options.stopped ? 'true' : 'false',
      stopped: options.stopped ? 'true' : 'false',
      autoTMM: 'false',
      sequentialDownload: 'true',
      firstLastPiecePrio: 'true',
    };
    let form: Record<string, string> | FormData;
    if (source.type === 'magnet') {
      form = { urls: source.magnet, ...common };
    } else if (source.type === 'torrent') {
      const upload = new FormData();
      upload.set('torrents', new Blob([new Uint8Array(source.bytes)]), 'release.torrent');
      for (const [key, value] of Object.entries(common)) upload.set(key, value);
      form = upload;
    } else {
      throw new ConnectionError('unexpected_response');
    }
    const response = await this.api('/api/v2/torrents/add', signal, form);
    if ((await smallText(response)).trim() === 'Fails.') throw new ConnectionError('unexpected_response');
  }

  async setFilesSelected(infoHash: string, ids: number[], selected: boolean, signal: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    await this.api('/api/v2/torrents/filePrio', signal, {
      hash: infoHash, id: ids.join('|'), priority: selected ? '1' : '0',
    });
  }

  async setShareLimits(infoHash: string, limits: { ratioLimit: number; seedingTimeLimit?: number }, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/setShareLimits', signal, {
      hashes: infoHash,
      ratioLimit: String(limits.ratioLimit),
      seedingTimeLimit: String(limits.seedingTimeLimit ?? -1),
      inactiveSeedingTimeLimit: '-1',
    });
  }

  async setSequential(infoHash: string, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/toggleSequentialDownload', signal, { hashes: infoHash });
  }

  async setFirstLastPiecePriority(infoHash: string, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/toggleFirstLastPiecePrio', signal, { hashes: infoHash });
  }

  async remove(infoHash: string, deleteFiles: boolean, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/delete', signal, {
      hashes: infoHash, deleteFiles: deleteFiles ? 'true' : 'false',
    });
  }

  async addMarker(infoHash: string, marker: string, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/addTags', signal, { hashes: infoHash, tags: marker });
  }
  async setRunning(hash: string, running: boolean, signal: AbortSignal): Promise<void> {
    const major = Number((await this.version(signal)).replace(/^v/, '').split('.')[0]);
    const action = major >= 5 ? (running ? 'start' : 'stop') : (running ? 'resume' : 'pause');
    await this.api(`/api/v2/torrents/${action}`, signal, { hashes: hash });
  }
}
