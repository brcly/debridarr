import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAdminRoutes, HttpError } from './admin/routes.js';
import type { Config } from './config.js';
import { SettingsStorageError, SettingsValidationError, type SettingsStore } from './settings.js';
import { manifest } from './addon/manifest.js';
import { getStreams, parseMediaId } from './addon/streams.js';
import { AddonAccess, sourceIdentity } from './security/addon.js';
import { Admission, BusyError } from './security/admission.js';
import { ConflictError } from './downloads/coordinator.js';
import type { DownloadsStore } from './downloads/store.js';
import { QBittorrentClient } from './integrations/qbittorrent/client.js';
import { handlePlay } from './playback/index.js';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createApp(deps?: { config: Config; store: SettingsStore; downloads?: DownloadsStore; access?: AddonAccess }) {
  const access = deps ? deps.access ? Promise.resolve(deps.access) : AddonAccess.open(deps.config.dataDir) : undefined;
  void access?.catch(() => {});
  const adminRoutes = deps ? createAdminRoutes(deps.config, deps.store, deps.downloads, undefined, access) : undefined;
  const searches = new Admission(4, 30);
  const preparations = new Admission(2);
  const streams = new Admission(16);
  const assets = new Map([
    ['/configure', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/assets/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/assets/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ]);
  const handle = async (request: import('node:http').IncomingMessage, response: ServerResponse) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { throw new HttpError(400, 'Invalid request URL'); }
    if (pathname.startsWith('/api/admin/')) {
      if (!adminRoutes) throw new HttpError(503, 'Administration is unavailable');
      await adminRoutes(request, response, pathname);
      return;
    }
    if (pathname === '/' || assets.has(pathname)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (pathname === '/') {
        response.writeHead(302, { Location: '/configure' });
        response.end();
      } else {
        const asset = assets.get(pathname)!;
        const content = await readFile(new URL(`./web/${asset.file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': asset.type });
        response.end(content);
      }
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD, OPTIONS');
      json(response, 405, { error: 'Method not allowed' });
      return;
    }

    if (pathname === '/health') {
      json(response, 200, { status: 'ok' });
      return;
    }
    const protectedPath = /^\/addon\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(pathname);
    const auth = await access;
    if (!protectedPath || !auth?.valid(protectedPath[1]!)) throw new HttpError(404, 'Not found');
    const addonBase = `${deps!.config.appUrl}/addon/${protectedPath[1]}`;
    pathname = protectedPath[2]!;
    if (pathname === '/configure') {
      response.writeHead(302, { Location: '/configure' }); response.end(); return;
    }
    if (pathname === '/manifest.json') {
      json(response, 200, manifest);
      return;
    }

    if (pathname.startsWith('/play/')) {
      const id = pathname.slice('/play/'.length);
      const settings = deps!.store.snapshot();
      const target = auth.get(id, sourceIdentity(settings.prowlarr));
      if (!target) throw new HttpError(404, 'Release expired or unknown. Search again.');
      if (!deps?.downloads) throw new HttpError(503, 'Playback is unavailable');
      const releaseStream = streams.enter();
      let releasePrepare: (() => void) | undefined;
      try {
        releasePrepare = preparations.enter();
        await handlePlay(request, response, target, {
          config: deps.config, qbt: new QBittorrentClient(settings.qbittorrent),
          store: deps.downloads, retention: settings.retention, prowlarr: settings.prowlarr,
          prepared: () => { releasePrepare?.(); releasePrepare = undefined; },
        });
      } finally { releasePrepare?.(); releaseStream(); }
      return;
    }

    const match = /^\/stream\/([^/]+)\/([^/]+)\.json$/.exec(pathname);
    if (match) {
      let type: string;
      let id: string;
      try {
        type = decodeURIComponent(match[1]!);
        id = decodeURIComponent(match[2]!);
      } catch {
        json(response, 400, { error: 'Invalid URL encoding' });
        return;
      }
      const mediaId = parseMediaId(type, id);
      if (mediaId) {
        const releaseSearch = searches.enter();
        try {
          const settings = deps!.store.snapshot();
          const result = await getStreams(mediaId, { settings, appUrl: addonBase,
            issue: targets => auth.issue(targets, sourceIdentity(settings.prowlarr)),
          });
          json(response, 200, result);
        } finally { releaseSearch(); }
        return;
      }
    }
    json(response, 404, { error: 'Not found' });
  };
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const expected = error instanceof HttpError || error instanceof BusyError || error instanceof ConflictError
        || error instanceof SettingsValidationError || error instanceof SettingsStorageError;
      const status = error instanceof HttpError || error instanceof BusyError || error instanceof ConflictError ? error.status : error instanceof SettingsValidationError ? 400 : 500;
      if (error instanceof BusyError) response.setHeader('Retry-After', '15');
      if (!expected) {
        // Unexpected failures answer with a generic message; log enough to place them.
        const e = error as Partial<Error> & { code?: unknown };
        const trace = (e.stack ?? '').split('\n').slice(1, 4).map(line => line.trim()).join(' <- ');
        const url = request.url ? new URL(request.url, 'http://x').pathname : '?';
        console.error(`Debridarr ${request.method} ${url} failed: ${typeof e.code === 'string' ? `${e.code} ` : ''}${e.name ?? 'Error'}: ${e.message ?? String(error)}${trace ? ` | ${trace}` : ''}`);
      }
      const message = expected ? (error as Error).message : 'An internal error occurred';
      json(response, status, { error: message });
    });
  });
}
