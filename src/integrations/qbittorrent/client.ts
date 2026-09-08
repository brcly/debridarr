import { sourceIdentity } from '../../security/addon.js';
import type { Settings } from '../../settings.js';
import { checkConnection, ConnectionError, serviceFetch, smallText, validVersion } from '../http.js';

export interface QbtTorrent {
  hash: string;
  category: string;
  tags: string[];
  name: string;
  state: string;
  progress: number;
  size: number;
  ratio: number;
  savePath: string;
  contentPath: string;
  amountLeft: number;
  numSeeds: number;
  numLeechs: number;
  dlspeed: number;
  eta: number;
  sequential: boolean;
  firstLastPiecePrio: boolean;
}

export interface QbtFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

const BODY_LIMIT = 8 * 1024 * 1024;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toTorrent(raw: unknown): QbtTorrent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.hash !== 'string') return undefined;
  return {
    hash: r.hash.toLowerCase(),
    category: text(r.category),
    tags: text(r.tags).split(',').map(t => t.trim()).filter(Boolean),
    name: text(r.name),
    state: text(r.state),
    progress: num(r.progress),
    size: num(r.size),
    ratio: num(r.ratio),
    savePath: text(r.save_path),
    contentPath: text(r.content_path),
    amountLeft: num(r.amount_left),
    numSeeds: num(r.num_seeds),
    numLeechs: num(r.num_leechs),
    dlspeed: num(r.dlspeed),
    eta: num(r.eta),
    sequential: r.seq_dl === true,
    firstLastPiecePrio: r.f_l_piece_prio === true,
  };
}

// Full qBittorrent Web API client: a shared session cookie, re-login on
// expiry, and the torrent operations `/play` and the retention sweeper need.
export class QBittorrentClient {
  private cookie = '';
  constructor(private readonly settings: Settings['qbittorrent']) {}

  get identity(): string { return sourceIdentity({ url: this.settings.url }); }

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
    if (body !== 'Ok.') throw new ConnectionError('unexpected_response');
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]!).find(value => /^SID=[\w-]+$/.test(value));
    if (!cookie) throw new ConnectionError('authentication');
    this.cookie = cookie;
  }

  // GET/POST an API path with the session cookie, logging in first and retrying
  // once if the session has expired.
  private async api(path: string, signal: AbortSignal, form?: Record<string, string> | FormData): Promise<Response> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const send = async () => {
      if (!this.cookie) await this.login(signal);
      const init: RequestInit = { headers: { Cookie: this.cookie, Origin: this.origin } };
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
        return send();
      }
      throw error;
    }
  }

  private async json(path: string, signal: AbortSignal, form?: Record<string, string>): Promise<unknown> {
    const response = await this.api(path, signal, form);
    try { return JSON.parse(await smallText(response, BODY_LIMIT)); }
    catch { throw new ConnectionError('unexpected_response'); }
  }

  async version(signal: AbortSignal): Promise<string> {
    const response = await this.api('/api/v2/app/version', signal);
    const version = (await smallText(response)).trim();
    if (!validVersion(version)) throw new ConnectionError('unexpected_response');
    return version;
  }

  test(timeoutMs = 10_000) { return checkConnection(signal => this.version(signal), timeoutMs); }

  async torrent(infoHash: string, signal: AbortSignal): Promise<QbtTorrent | undefined> {
    const list = await this.json(`/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash)}`, signal);
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    return list.map(toTorrent).find((entry): entry is QbtTorrent => entry?.hash === infoHash.toLowerCase());
  }

  async torrentsByCategory(category: string, signal: AbortSignal): Promise<QbtTorrent[]> {
    const list = await this.json(`/api/v2/torrents/info?category=${encodeURIComponent(category)}`, signal);
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    return list.map(toTorrent).filter((entry): entry is QbtTorrent => entry !== undefined);
  }

  async files(infoHash: string, signal: AbortSignal): Promise<QbtFile[]> {
    const list = await this.json(`/api/v2/torrents/files?hash=${encodeURIComponent(infoHash)}`, signal);
    if (!Array.isArray(list)) throw new ConnectionError('unexpected_response');
    return list.map((raw, fallback): QbtFile => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        index: typeof r.index === 'number' ? r.index : fallback,
        name: text(r.name),
        size: num(r.size),
        progress: num(r.progress),
        priority: num(r.priority),
      };
    });
  }

  async add(magnet: string, options: { category: string; paused?: boolean; tags?: string }, signal: AbortSignal): Promise<void> {
    const response = await this.api('/api/v2/torrents/add', signal, {
      urls: magnet,
      category: options.category,
      tags: options.tags ?? '',
      ratioLimit: '-1', seedingTimeLimit: '-1', inactiveSeedingTimeLimit: '-1',
      paused: options.paused ? 'true' : 'false',
      stopped: options.paused ? 'true' : 'false',
      autoTMM: 'false',
    });
    if ((await smallText(response)).trim() === 'Fails.') throw new ConnectionError('unexpected_response');
  }

  // Uploads a .torrent file's raw bytes directly, preserving its trackers and
  // web seeds. Used for releases that only give a download URL, not a magnet
  // — a synthetic bare-hash magnet would have no announce URL and rely
  // entirely on DHT/PEX, which private trackers don't support.
  async addTorrentFile(bytes: Uint8Array, options: { category: string; paused?: boolean; tags?: string }, signal: AbortSignal): Promise<void> {
    const form = new FormData();
    form.set('torrents', new Blob([new Uint8Array(bytes)]), 'release.torrent');
    form.set('category', options.category);
    form.set('tags', options.tags ?? '');
    form.set('ratioLimit', '-1');
    form.set('seedingTimeLimit', '-1');
    form.set('inactiveSeedingTimeLimit', '-1');
    form.set('paused', options.paused ? 'true' : 'false');
    form.set('stopped', options.paused ? 'true' : 'false');
    form.set('autoTMM', 'false');
    const response = await this.api('/api/v2/torrents/add', signal, form);
    if ((await smallText(response)).trim() === 'Fails.') throw new ConnectionError('unexpected_response');
  }

  async setFilePriorities(infoHash: string, indices: number[], priority: number, signal: AbortSignal): Promise<void> {
    if (indices.length === 0) return;
    await this.api('/api/v2/torrents/filePrio', signal, {
      hash: infoHash, id: indices.join('|'), priority: String(priority),
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

  async delete(infoHash: string, deleteFiles: boolean, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/delete', signal, {
      hashes: infoHash, deleteFiles: deleteFiles ? 'true' : 'false',
    });
  }

  async addTags(hash: string, tag: string, signal: AbortSignal): Promise<void> {
    await this.api('/api/v2/torrents/addTags', signal, { hashes: hash, tags: tag });
  }
  async setRunning(hash: string, running: boolean, signal: AbortSignal): Promise<void> {
    const major = Number((await this.version(signal)).replace(/^v/, '').split('.')[0]);
    const action = major >= 5 ? (running ? 'start' : 'stop') : (running ? 'resume' : 'pause');
    await this.api(`/api/v2/torrents/${action}`, signal, { hashes: hash });
  }
}
