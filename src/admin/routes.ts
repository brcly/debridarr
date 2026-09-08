import { ConflictError } from '../downloads/coordinator.js';
import { BusyError } from '../security/admission.js';
import { AddonAccess, sourceIdentity } from '../security/addon.js';
import { deleteManaged } from '../downloads/deletion.js';
import type { DownloadRecord } from '../downloads/store.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import { applySettingsPatch, publicSettings, type SettingsStore } from '../settings.js';
import { DEBRIDARR_CATEGORY } from '../downloads/manager.js';
import type { DownloadsStore } from '../downloads/store.js';
import { ProwlarrClient } from '../integrations/prowlarr/client.js';
import { QBittorrentClient, type QbtTorrent } from '../integrations/qbittorrent/client.js';
import { isActive } from '../playback/active.js';
import { COOKIE_NAME, sessionCookie, Sessions } from './auth.js';

const HASH_PATH = /^\/api\/admin\/downloads\/([a-f0-9]{40})$/i;

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new HttpError(415, 'Use application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  // Do not destroy the request on rejection: the caller still needs the JSON error.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024) { request.resume(); throw new HttpError(413, 'Request is too large'); }
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function downloadView(record: DownloadRecord, torrent: QbtTorrent | undefined) {
  return {
    lifecycle: record.lifecycle ?? 'legacy', failure: record.failure ?? null,
    infoHash: record.infoHash, name: record.name, imdbId: record.imdbId, type: record.type,
    ...(record.season === undefined ? {} : { season: record.season }),
    ...(record.episode === undefined ? {} : { episode: record.episode }),
    bytes: record.bytes, addedAt: record.addedAt, expiresAt: record.expiresAt, kept: record.kept,
    ratio: torrent?.ratio ?? null, progress: torrent?.progress ?? null, state: torrent?.state ?? null, eta: torrent?.eta ?? null,
  };
}

export function createAdminRoutes(config: Config, store: SettingsStore, downloads?: DownloadsStore, sessions = new Sessions(config.adminPassword), access?: Promise<AddonAccess>) {
  const origin = new URL(config.appUrl);
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    if (request.headers.host !== origin.host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin.origin)) {
      throw new HttpError(403, 'Open the administration site using the configured APP_URL');
    }
    const mutation = request.method !== 'GET' && request.method !== 'HEAD';
    if (mutation && request.headers.origin !== origin.origin) throw new HttpError(403, 'Origin verification failed');
    const token = request.headers.cookie?.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? '';
    if (pathname === '/api/admin/login' && request.method === 'POST') {
      const input = await body(request);
      if (!input || typeof input !== 'object' || !('password' in input) || typeof input.password !== 'string') {
        throw new HttpError(400, 'Enter an administrator password');
      }
      const result = sessions.login(input.password, request.socket.remoteAddress ?? 'unknown');
      if (result === 'throttled') {
        response.setHeader('Retry-After', '900');
        throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
      }
      if (result === 'invalid') throw new HttpError(401, 'Incorrect administrator password');
      sessions.delete(token);
      response.setHeader('Set-Cookie', sessionCookie(result.token, origin.protocol === 'https:'));
      json(response, 200, { csrfToken: result.session.csrfToken });
      return;
    }
    const session = sessions.get(token);
    if (!session) throw new HttpError(401, 'Sign in to manage Debridarr');
    if (mutation && request.headers['x-csrf-token'] !== session.csrfToken) throw new HttpError(403, 'Session verification failed. Reload and try again.');
    const hashMatch = HASH_PATH.exec(pathname);
    if (pathname === '/api/admin/session' && request.method === 'GET') {
      json(response, 200, { csrfToken: session.csrfToken });
    } else if (pathname === '/api/admin/logout' && request.method === 'POST') {
      await body(request);
      sessions.delete(token);
      response.setHeader('Set-Cookie', sessionCookie('', origin.protocol === 'https:', true));
      json(response, 200, { ok: true });
    } else if (pathname === '/api/admin/addon' && ['GET', 'POST'].includes(request.method ?? '')) {
      const addon = await access;
      if (!addon) throw new HttpError(503, 'Addon access unavailable');
      if (request.method === 'POST') { await body(request); await addon.rotate(); }
      json(response, 200, { manifestUrl: `${addon.base(config.appUrl)}/manifest.json` });
    } else if (pathname === '/api/admin/settings' && request.method === 'GET') {
      json(response, 200, {
        settings: publicSettings(store.snapshot()),
        deployment: { appUrl: config.appUrl, port: config.port, downloadDir: config.downloadDir },
      });
    } else if (pathname === '/api/admin/settings' && request.method === 'PATCH') {
      const previous = sourceIdentity(store.snapshot().prowlarr);
      const settings = await store.update(await body(request));
      if (sourceIdentity(settings.prowlarr) !== previous) await (await access)?.invalidate();
      json(response, 200, { settings: publicSettings(settings) });
    } else if (request.method === 'POST' && ['/api/admin/test/prowlarr', '/api/admin/test/qbittorrent'].includes(pathname)) {
      const service = pathname.endsWith('/prowlarr') ? 'prowlarr' : 'qbittorrent';
      const draft = applySettingsPatch(store.snapshot(), { [service]: await body(request) });
      const result = service === 'prowlarr'
        ? await new ProwlarrClient(draft.prowlarr).test()
        : await new QBittorrentClient(draft.qbittorrent).test();
      json(response, 200, result);
    } else if (pathname === '/api/admin/downloads' && request.method === 'GET') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const qbt = new QBittorrentClient(store.snapshot().qbittorrent);
      const torrents = await qbt.torrentsByCategory(DEBRIDARR_CATEGORY, AbortSignal.timeout(10_000)).catch(() => []);
      const byHash = new Map(torrents.map(t => [t.hash, t]));
      json(response, 200, { downloads: downloads.list().map(record => downloadView(record, byHash.get(record.infoHash))) });
    } else if (hashMatch && request.method === 'PATCH') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const input = await body(request);
      if (!input || typeof input !== 'object' || typeof (input as Record<string, unknown>).kept !== 'boolean') {
        throw new HttpError(400, 'kept must be a boolean');
      }
      const record = await downloads.setKept(hashMatch[1]!, (input as { kept: boolean }).kept);
      if (!record) throw new HttpError(404, 'Unknown download');
      json(response, 200, { download: downloadView(record, undefined) });
    } else if (hashMatch && request.method === 'DELETE') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const infoHash = hashMatch[1]!;
      if (!downloads.get(infoHash)) throw new HttpError(404, 'Unknown download');
      if (isActive(infoHash)) throw new HttpError(409, 'This title is currently being streamed');
      const qbt = new QBittorrentClient(store.snapshot().qbittorrent);
      try { await deleteManaged(downloads, qbt, infoHash, AbortSignal.timeout(10_000)); }
      catch (error) {
        if (error instanceof ConflictError || error instanceof BusyError) throw error;
        throw new HttpError(502, 'Deletion could not be confirmed. The download remains tracked; retry after checking qBittorrent.');
      }
      json(response, 200, { ok: true });
    } else {
      throw new HttpError(404, 'Not found');
    }
  };
}
