import { legacyBackendId, type SabnzbdBackendSettings } from '../../backends/config.js';
import type { BackendOwnership, DownloadBackend, DownloadCapabilities, DownloadFile, DownloadSnapshot, DownloadSource } from '../../backends/download.js';
import { nzbIdentity } from '../../downloads/nzb.js';
import { ConnectionError, checkConnection, smallText, validVersion } from '../http.js';
import { objectRecord } from '../../json.js';
import { CONNECTION_TEST_TIMEOUT_MS } from '../../timeouts.js';

const BODY_LIMIT = 8 * 1024 * 1024;
const LABEL_SEP = '__';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Number(value) : 0;
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

function mbToBytes(mb: unknown): number {
  const n = num(mb);
  return Number.isFinite(n) ? Math.round(n * 1024 * 1024) : 0;
}

function parseEta(timeleft: string): number {
  const parts = timeleft.split(':').map(Number);
  if (parts.length === 3 && parts.every(n => Number.isFinite(n))) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2 && parts.every(n => Number.isFinite(n))) return parts[0]! * 60 + parts[1]!;
  return 0;
}

function jobState(status: string, complete: boolean): string {
  const s = status.toLowerCase();
  if (complete || s === 'completed') return 'stopped';
  if (s === 'paused') return 'paused';
  if (s === 'failed' || s === 'error') return 'error';
  return s || 'downloading';
}

interface SabJob {
  nzoId: string;
  identity: string;
  cat: string;
  name: string;
  status: string;
  progress: number;
  bytes: number;
  bytesLeft: number;
  speed: number;
  eta: number;
  savePath: string;
  history: boolean;
}

function identityOf(slot: Record<string, unknown>): string {
  for (const key of ['filename', 'nzb_name', 'name'] as const) {
    const name = text(slot[key]);
    if (/^[a-f0-9]{40}$/i.test(name)) return name.toLowerCase();
  }
  return '';
}

function fromQueueSlot(slot: Record<string, unknown>): SabJob | undefined {
  const nzoId = text(slot.nzo_id);
  const identity = identityOf(slot);
  if (!nzoId || !identity) return undefined;
  const mb = num(slot.mb);
  const mbleft = num(slot.mbleft);
  const percentage = num(slot.percentage);
  return {
    nzoId, identity, cat: text(slot.cat), name: text(slot.filename) || identity,
    status: text(slot.status), progress: Math.min(1, Math.max(0, percentage / 100)),
    bytes: mbToBytes(mb), bytesLeft: mbToBytes(mbleft),
    speed: num(slot.kbpersec) * 1000, eta: parseEta(text(slot.timeleft)),
    savePath: '', history: false,
  };
}

function fromHistorySlot(slot: Record<string, unknown>): SabJob | undefined {
  const nzoId = text(slot.nzo_id);
  const identity = identityOf(slot);
  if (!nzoId || !identity) return undefined;
  const bytes = num(slot.bytes) || mbToBytes(slot.mb);
  return {
    nzoId, identity, cat: text(slot.category) || text(slot.cat), name: text(slot.name) || identity,
    status: text(slot.status), progress: 1, bytes, bytesLeft: 0, speed: 0, eta: 0,
    savePath: text(slot.storage) || text(slot.path), history: true,
  };
}

function toSnapshot(job: SabJob): DownloadSnapshot {
  const { scope, markers } = decodeLabel(job.cat);
  return {
    infoHash: job.identity,
    scope,
    markers,
    name: job.name,
    state: jobState(job.status, job.history),
    progress: job.history ? 1 : job.progress,
    bytes: job.bytes,
    ratio: 0,
    savePath: job.savePath,
    contentPath: job.savePath,
    bytesRemaining: job.history ? 0 : job.bytesLeft,
    seeders: 0,
    leechers: 0,
    downloadSpeed: job.speed,
    eta: job.eta,
  };
}

// SABnzbd JSON API client: API-key query auth, queue+history as one job list,
// category-packed ownership, and NZB upload. No torrent capability groups.
export class SabnzbdClient implements DownloadBackend {
  private readonly settings: SabnzbdBackendSettings;

  constructor(settings: Omit<SabnzbdBackendSettings, 'id' | 'type' | 'protocol' | 'pathMappings'> & Partial<Pick<SabnzbdBackendSettings, 'id' | 'type' | 'pathMappings'>>) {
    this.settings = {
      ...settings,
      id: settings.id ?? legacyBackendId(settings.url),
      type: 'sabnzbd',
      protocol: 'usenet',
      pathMappings: settings.pathMappings ?? [],
    };
  }

  readonly protocol = 'usenet' as const;

  readonly capabilities: DownloadCapabilities = {
    freeSpace: (signal: AbortSignal) => this.freeSpace(signal),
    markers: { add: (infoHash: string, marker: string, signal: AbortSignal) => this.addMarker(infoHash, marker, signal) },
  };

  get identity(): string { return this.settings.id; }
  get pathMappings() { return this.settings.pathMappings; }
  get configured(): boolean { return Boolean(this.settings.url && this.settings.password); }

  private get origin(): string {
    return this.settings.url.replace(/\/+$/, '');
  }

  private url(mode: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ mode, output: 'json', apikey: this.settings.password, ...extra });
    return `${this.origin}/api?${params}`;
  }

  private async call(mode: string, extra: Record<string, string>, signal: AbortSignal, init?: RequestInit): Promise<Record<string, unknown>> {
    if (!this.configured) throw new ConnectionError('not_configured');
    const response = await fetch(this.url(mode, extra), { ...init, signal, redirect: 'manual' });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ConnectionError('authentication');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ConnectionError('unexpected_response');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await smallText(response, BODY_LIMIT)); }
    catch { throw new ConnectionError('unexpected_response'); }
    const body = objectRecord(parsed);
    if (!body) throw new ConnectionError('unexpected_response');
    const error = text(body.error);
    if (error) throw new ConnectionError(/api key/i.test(error) ? 'authentication' : 'unexpected_response');
    return body;
  }

  async version(signal: AbortSignal): Promise<string> {
    // version does not require a key; queue does, and also reports version.
    const body = await this.call('queue', {}, signal);
    const queue = objectRecord(body.queue) ?? {};
    const version = text(queue.version);
    if (!validVersion(version)) throw new ConnectionError('unexpected_response');
    return version;
  }

  test(timeoutMs = CONNECTION_TEST_TIMEOUT_MS) { return checkConnection(signal => this.version(signal), timeoutMs); }

  async freeSpace(signal: AbortSignal): Promise<number> {
    const body = await this.call('queue', { limit: '0' }, signal);
    const queue = objectRecord(body.queue) ?? {};
    const gb = num(queue.diskspace1);
    if (!Number.isFinite(gb) || gb < 0) throw new ConnectionError('unexpected_response');
    return Math.round(gb * 1e9);
  }

  private async jobs(signal: AbortSignal): Promise<SabJob[]> {
    const [queueBody, historyBody] = await Promise.all([
      this.call('queue', {}, signal),
      this.call('history', { limit: '1000' }, signal),
    ]);
    const queue = objectRecord(queueBody.queue) ?? {};
    const history = objectRecord(historyBody.history) ?? {};
    const jobs: SabJob[] = [];
    for (const slot of Array.isArray(queue.slots) ? queue.slots : []) {
      const rec = objectRecord(slot);
      if (!rec) continue;
      const job = fromQueueSlot(rec);
      if (job) jobs.push(job);
    }
    for (const slot of Array.isArray(history.slots) ? history.slots : []) {
      const rec = objectRecord(slot);
      if (!rec) continue;
      const job = fromHistorySlot(rec);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private async job(identity: string, signal: AbortSignal): Promise<SabJob | undefined> {
    const id = identity.toLowerCase();
    return (await this.jobs(signal)).find(entry => entry.identity === id);
  }

  async get(infoHash: string, signal: AbortSignal): Promise<DownloadSnapshot | undefined> {
    const found = await this.job(infoHash, signal);
    return found ? toSnapshot(found) : undefined;
  }

  async list(scope: string, signal: AbortSignal): Promise<DownloadSnapshot[]> {
    return (await this.jobs(signal)).map(toSnapshot).filter(entry => entry.scope === scope);
  }

  async getFiles(infoHash: string, signal: AbortSignal): Promise<DownloadFile[]> {
    const found = await this.job(infoHash, signal);
    if (!found) return [];
    if (found.history) {
      return found.savePath
        ? [{ id: 0, path: found.savePath.split(/[/\\]/).pop() || found.name, bytes: found.bytes, progress: 1, selected: true }]
        : [];
    }
    const body = await this.call('get_files', { value: found.nzoId }, signal);
    const files = Array.isArray(body.files) ? body.files : [];
    return files.map((file, index): DownloadFile => {
      const f = objectRecord(file) ?? {};
      const bytes = num(f.bytes) || mbToBytes(f.mb);
      const left = mbToBytes(f.mbleft);
      return {
        id: index,
        path: text(f.filename) || `file-${index}`,
        bytes,
        progress: bytes > 0 ? Math.min(1, Math.max(0, 1 - left / bytes)) : text(f.status) === 'finished' ? 1 : 0,
        selected: text(f.status) !== 'paused',
      };
    });
  }

  async submit(source: DownloadSource, options: { ownership: BackendOwnership; stopped?: boolean }, signal: AbortSignal): Promise<void> {
    if (source.type !== 'nzb') throw new ConnectionError('unexpected_response');
    const identity = nzbIdentity(source.bytes);
    const existing = await this.job(identity, signal);
    const label = encodeLabel(options.ownership.scope, [options.ownership.marker]);
    if (existing) {
      if (!existing.history) await this.call('queue', { name: 'change_cat', value: existing.nzoId, value2: label }, signal);
      return;
    }
    const form = new FormData();
    form.set('nzbfile', new Blob([Uint8Array.from(source.bytes)]), 'release.nzb');
    const body = await this.call('addfile', {
      nzbname: identity,
      cat: label,
      priority: options.stopped ? '-2' : '0',
    }, signal, { method: 'POST', body: form });
    const ids = body.nzo_ids;
    if (body.status === false || (Array.isArray(ids) && ids.length === 0)) throw new ConnectionError('unexpected_response');
  }

  async setFilesSelected(infoHash: string, ids: number[], selected: boolean, signal: AbortSignal): Promise<void> {
    if (ids.length === 0 || selected) return;
    const found = await this.job(infoHash, signal);
    if (!found || found.history) return;
    const body = await this.call('get_files', { value: found.nzoId }, signal);
    const files = Array.isArray(body.files) ? body.files : [];
    const nzfIds = ids.map(id => text(objectRecord(files[id])?.nzf_id)).filter(Boolean);
    if (!nzfIds.length) return;
    await this.call('queue', { name: 'delete_nzf', value: found.nzoId, value2: nzfIds.join(',') }, signal);
  }

  async addMarker(infoHash: string, marker: string, signal: AbortSignal): Promise<void> {
    const found = await this.job(infoHash, signal);
    if (!found) return;
    const { scope, markers } = decodeLabel(found.cat);
    if (markers.includes(marker)) return;
    if (found.history) return;
    await this.call('queue', { name: 'change_cat', value: found.nzoId, value2: encodeLabel(scope || 'debridarr', [...markers, marker]) }, signal);
  }

  async remove(infoHash: string, deleteFiles: boolean, signal: AbortSignal): Promise<void> {
    const found = await this.job(infoHash, signal);
    if (!found) return;
    const extra = { name: 'delete', value: found.nzoId, del_files: deleteFiles ? '1' : '0' };
    await this.call(found.history ? 'history' : 'queue', extra, signal);
  }

  async setRunning(infoHash: string, running: boolean, signal: AbortSignal): Promise<void> {
    const found = await this.job(infoHash, signal);
    if (!found || found.history) return;
    await this.call('queue', { name: running ? 'resume' : 'pause', value: found.nzoId }, signal);
  }
}
