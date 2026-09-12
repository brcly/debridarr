import { DownloadError, downloadErrorStatus } from './downloads/manager.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAdminRoutes } from './admin/routes.js';
import { HttpError, json } from './http.js';
import type { Config } from './config.js';
import { SettingsStorageError, SettingsValidationError, type Settings } from './settings.js';
import type { AddonAccessRepository, DownloadsRepository, IdempotencyRepository, SettingsRepository, StoreAccessRepository } from './state/repositories.js';
import { JsonIdempotencyStore } from './state/json/idempotency.js';
import { buildManifest, LIBRARY_CATALOG_ID } from './addon/manifest.js';
import { getStreams, parseMediaId } from './addon/streams.js';
import { catalogExtras, getStoreStreams, libraryMeta, libraryMetas } from './addon/library.js';
import { parseDbId } from './domain/ids.js';
import { StoreAccess } from './store/access.js';
import { isStorePath, storeRoutes } from './store/routes.js';
import { apiV1Routes, isApiV1Path } from './api/v1/routes.js';
import { IdempotencyCache } from './api/v1/idempotency.js';
import { nativeLinkIssuer, verifyLink } from './api/v1/links.js';
import { davRoutes, isDavPath } from './dav/routes.js';
import { transferServiceFor } from './application/factory.js';
import type { PrepareTransferRequest } from './application/types.js';
import { AddonAccess, sourceIdentity } from './security/addon.js';
import { Admission, BusyError } from './security/admission.js';
import { ConflictError } from './downloads/coordinator.js';

import { createDownloadBackend } from './backends/factory.js';
import { handlePlay } from './playback/index.js';
import { fetchTorrentSource } from './security/torrentSource.js';
import { discoveryProxyTargets } from './discovery/registry.js';
import { log, logRequest, requestId, setLogLevel } from './log.js';
import { READY_BACKEND_TIMEOUT_MS } from './timeouts.js';
import { recordRequest } from './metrics.js';

const decodeSafe = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
const READY_CACHE_TTL_MS = 15_000;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export interface AppDeps {
  config: Config;
  store: SettingsRepository;
  downloads?: DownloadsRepository;
  access?: AddonAccessRepository;
  storeAccess?: StoreAccessRepository;
  idempotency?: IdempotencyRepository;
}

export function createApp(deps: AppDeps) {
  setLogLevel(deps.config.logLevel);
  const access = deps.access ? Promise.resolve(deps.access) : AddonAccess.open(deps.config.dataDir);
  void access.catch(() => {});
  const storeAccess = deps.storeAccess ? Promise.resolve(deps.storeAccess) : StoreAccess.open(deps.config.dataDir);
  void storeAccess.catch(() => {});
  const searches = new Admission(4, 30);
  const streams = new Admission(16);
  const adminRoutes = createAdminRoutes(deps.config, deps.store, deps.downloads, undefined, access, storeAccess, searches, streams);
  let readyCache: { at: number; status: 'ready' | 'not_ready'; checks: Record<string, 'ok' | 'error'> } | undefined;
  const idempotency = new IdempotencyCache(deps.idempotency ?? new JsonIdempotencyStore());
  const assetFiles: Record<string, { file: string; type: string }> = {
    '/configure': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/assets/discovery-panel.js': { file: 'discovery-panel.js', type: 'text/javascript; charset=utf-8' },
    '/assets/dom.js': { file: 'dom.js', type: 'text/javascript; charset=utf-8' },
    '/assets/downloads-panel.js': { file: 'downloads-panel.js', type: 'text/javascript; charset=utf-8' },
    '/assets/pure.js': { file: 'pure.js', type: 'text/javascript; charset=utf-8' },
    '/assets/saved-searches-panel.js': { file: 'saved-searches-panel.js', type: 'text/javascript; charset=utf-8' },
    '/assets/setup-panel.js': { file: 'setup-panel.js', type: 'text/javascript; charset=utf-8' },
    '/assets/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/assets/tokens-panel.js': { file: 'tokens-panel.js', type: 'text/javascript; charset=utf-8' },
  };
  // Read once, kicked off at startup rather than per request — these are
  // hit on every /configure load and admission-boundary revalidation.
  const assets = new Map(Object.entries(assetFiles).map(([pathname, meta]) => {
    const loaded = readFile(new URL(`./web/${meta.file}`, import.meta.url)).then(content => ({
      content, etag: `"${createHash('sha256').update(content).digest('hex')}"`,
    }));
    void loaded.catch(() => {});
    return [pathname, { type: meta.type, loaded }] as const;
  }));

  const handleStore = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (deps.store.snapshot().integrations.mode === 'search') throw new HttpError(404, 'Not found');
    await storeRoutes(request, response, new URL(request.url!, 'http://localhost'), await storeAccess, async () => {
      if (!deps.downloads) throw new HttpError(503, 'Downloads unavailable');
      const settings = deps.store.snapshot();
      return transferServiceFor({
        settings, downloads: deps.downloads, resolveSources: true,
        links: { appUrl: deps.config.appUrl, linkSecret: (await storeAccess).linkSecret() },
      });
    });
  };

  const handleDav = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await davRoutes(request, response, new URL(request.url!, 'http://localhost'), {
      storeAccess: await storeAccess,
      enabled: !!deps.downloads && deps.store.snapshot().integrations.mode !== 'search',
      service: async () => {
        if (!deps.downloads) throw new HttpError(503, 'Downloads unavailable');
        const settings = deps.store.snapshot();
        const backend = createDownloadBackend(settings.downloadBackend);
        return {
          backend, downloadDir: deps.config.downloadDir,
          service: transferServiceFor({ settings, downloads: deps.downloads, backend }),
        };
      },
    });
  };

  const handleDownloadLink = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Retry-After');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD, OPTIONS'); json(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } }); return; }
    if (!deps.downloads) throw new HttpError(404, 'Not found');
    const settings = deps.store.snapshot();
    if (settings.integrations.mode === 'search') throw new HttpError(404, 'Not found');
    const claim = verifyLink((await storeAccess).linkSecret(), pathname.slice('/api/v1/download/'.length), Date.now());
    if (!claim) throw new HttpError(404, 'This download link has expired or is unknown.');
    const req: PrepareTransferRequest = {
      source: { infoHash: claim.infoHash }, origin: 'store', name: claim.path.split('/').at(-1) || 'file', bytes: claim.bytes,
      selection: { file: { id: claim.fileId, path: claim.path, bytes: claim.bytes, marker: claim.marker }, behavior: 'allow-select' },
    };
    const releaseStream = streams.enter();
    try {
      await handlePlay(request, response, req, {
        config: deps.config, backend: createDownloadBackend(settings.downloadBackend),
        store: deps.downloads, retention: settings.retention, storeMaxActiveDownloads: settings.store.maxActiveDownloads,
        streamWhileDownloading: settings.playback.streamWhileDownloading,
      });
    } finally { releaseStream(); }
  };

  const handleApiV1 = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await apiV1Routes(request, response, new URL(request.url!, 'http://localhost'), {
      storeAccess: await storeAccess,
      idempotency,
      enabled: !!deps.downloads && deps.store.snapshot().integrations.mode !== 'search',
      service: async () => {
        if (!deps.downloads) throw new HttpError(503, 'Downloads unavailable');
        const settings = deps.store.snapshot();
        const backend = createDownloadBackend(settings.downloadBackend);
        return {
          settings, backend, downloadDir: deps.config.downloadDir,
          service: transferServiceFor({
            settings, downloads: deps.downloads, backend, resolveSources: true,
            links: { appUrl: deps.config.appUrl, linkSecret: (await storeAccess).linkSecret() },
          }),
        };
      },
    });
  };

  const handleAdmin = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    await adminRoutes(request, response, pathname);
  };

  const handleAsset = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (pathname === '/') {
      response.writeHead(302, { Location: '/configure' });
      response.end();
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) throw new HttpError(404, 'Not found');
    const { content, etag } = await asset.loaded;
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': asset.type });
    response.end(content);
  };

  // Routes that manage their own CORS/OPTIONS surface (or intentionally have
  // none, e.g. same-origin admin/WebDAV traffic). Checked in this order;
  // anything left over falls through to the CORS-enabled generic surface
  // below (health checks and the Stremio addon).
  const routes: { match: (pathname: string) => boolean; handler: (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<void> }[] = [
    { match: isStorePath, handler: handleStore },
    { match: isDavPath, handler: handleDav },
    { match: pathname => pathname.startsWith('/api/v1/download/'), handler: handleDownloadLink },
    { match: isApiV1Path, handler: handleApiV1 },
    { match: pathname => pathname.startsWith('/api/admin/'), handler: handleAdmin },
    { match: pathname => pathname === '/' || assets.has(pathname), handler: handleAsset },
  ];

  const handleReady = async (response: ServerResponse): Promise<void> => {
    if (!deps.downloads) { json(response, 503, { status: 'not_ready', checks: {} }); return; }
    const downloads = deps.downloads;
    if (!readyCache || Date.now() - readyCache.at >= READY_CACHE_TTL_MS) {
      const checks: Record<string, 'ok' | 'error'> = {};
      try { deps.store.snapshot(); checks.store = 'ok'; } catch { checks.store = 'error'; }
      try { downloads.list(); checks.downloads = 'ok'; } catch { checks.downloads = 'error'; }
      try {
        const result = await createDownloadBackend(deps.store.snapshot().downloadBackend).test(READY_BACKEND_TIMEOUT_MS);
        checks.backend = result.ok || result.code === 'not_configured' ? 'ok' : 'error';
      } catch { checks.backend = 'error'; }
      try { await stat(deps.config.downloadDir); checks.downloadDir = 'ok'; } catch { checks.downloadDir = 'error'; }
      const status = Object.values(checks).every(check => check === 'ok') ? 'ready' : 'not_ready';
      readyCache = { at: Date.now(), status, checks };
    }
    json(response, readyCache.status === 'ready' ? 200 : 503, { status: readyCache.status, checks: readyCache.checks });
  };

  // Everything under the Stremio addon's bearer-capability path: manifest,
  // playback, search streams, and (when downloads are enabled) the library
  // catalog/meta surface.
  const handleAddon = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    const protectedPath = /^\/addon\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(pathname);
    const auth = await access;
    if (!protectedPath || !auth.valid(protectedPath[1]!)) throw new HttpError(404, 'Not found');
    const addonBase = `${deps.config.appUrl}/addon/${protectedPath[1]}`;
    const apiBase = `${deps.config.appUrl}/api/v1`;
    const linkSecret = (await storeAccess).linkSecret();
    const transferService = (settings: Settings, downloads: DownloadsRepository) => transferServiceFor({
      settings, downloads, resolveSources: true, links: nativeLinkIssuer(apiBase, linkSecret),
    });
    const inner = protectedPath[2]!;
    if (inner === '/configure') {
      response.writeHead(302, { Location: '/configure' }); response.end(); return;
    }
    if (inner === '/manifest.json') {
      json(response, 200, buildManifest(deps.store.snapshot().integrations.mode));
      return;
    }

    if (inner.startsWith('/play/')) {
      const id = inner.slice('/play/'.length);
      const settings = deps.store.snapshot();
      const req = auth.get(id, sourceIdentity(settings.discovery.providers));
      if (!req) throw new HttpError(404, 'Release expired or unknown. Search again.');
      if (!deps.downloads) throw new HttpError(503, 'Playback is unavailable');
      const releaseStream = streams.enter();
      try {
        await handlePlay(request, response, req, {
          config: deps.config, backend: createDownloadBackend(settings.downloadBackend),
          store: deps.downloads, retention: settings.retention, storeMaxActiveDownloads: settings.store.maxActiveDownloads,
          sourceResolver: (url, signal) => fetchTorrentSource(url, signal, discoveryProxyTargets(settings)),
          streamWhileDownloading: settings.playback.streamWhileDownloading,
        });
      } finally { releaseStream(); }
      return;
    }

    const match = /^\/stream\/([^/]+)\/([^/]+)\.json$/.exec(inner);
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
      const settings = deps.store.snapshot();
      if (mediaId) {
        const releaseSearch = searches.enter();
        try {
          const result = await getStreams(mediaId, { settings, appUrl: addonBase,
            issue: targets => auth.issue(targets, sourceIdentity(settings.discovery.providers)),
            ...(deps.downloads ? { cache: { store: deps.downloads, backend: createDownloadBackend(settings.downloadBackend), config: deps.config } } : {}),
          });
          json(response, 200, result);
        } finally { releaseSearch(); }
        return;
      }
      if (settings.integrations.mode !== 'search' && deps.downloads && parseDbId(id)) {
        const releaseSearch = searches.enter();
        try {
          json(response, 200, await getStoreStreams(id, transferService(settings, deps.downloads)));
        } finally { releaseSearch(); }
        return;
      }
    }

    const settings = deps.store.snapshot();
    if (settings.integrations.mode !== 'search' && deps.downloads) {
      const catalog = /^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+))?\.json$/.exec(inner);
      if (catalog && decodeSafe(catalog[1]!) === 'other' && decodeSafe(catalog[2]!) === LIBRARY_CATALOG_ID) {
        json(response, 200, libraryMetas(transferService(settings, deps.downloads).list(), catalogExtras(catalog[3])));
        return;
      }
      const meta = /^\/meta\/([^/]+)\/(.+)\.json$/.exec(inner);
      if (meta) {
        const result = libraryMeta(transferService(settings, deps.downloads).list(), decodeSafe(meta[2]!));
        if (result) { json(response, 200, result); return; }
      }
    }
    json(response, 404, { error: 'Not found' });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (deps.config.appUrl.startsWith('https://')) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { throw new HttpError(400, 'Invalid request URL'); }
    if (pathname === '/configure' || pathname.startsWith('/assets/')) {
      response.setHeader('Content-Security-Policy', CSP);
    }

    const route = routes.find(candidate => candidate.match(pathname));
    if (route) { await route.handler(request, response, pathname); return; }

    // Generic CORS-enabled surface: liveness/readiness probes and the
    // Stremio addon (search streams, library catalog, playback).
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Retry-After');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
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
    if (pathname === '/health/ready') {
      await handleReady(response);
      return;
    }
    await handleAddon(request, response, pathname);
  };
  // StremThru clients batch 500 hashes in the URL (~22 KiB before headers).
  return createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
    const started = Date.now();
    const id = requestId(request.headers['x-request-id']);
    response.setHeader('X-Request-Id', id);
    let logged = false;
    const done = () => {
      if (logged) return;
      logged = true;
      recordRequest(response.statusCode);
      logRequest(request.method, request.url, response.statusCode, Date.now() - started, id);
    };
    response.on('finish', done);
    response.on('close', done);
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const expected = error instanceof DownloadError || error instanceof HttpError || error instanceof BusyError || error instanceof ConflictError
        || error instanceof SettingsValidationError || error instanceof SettingsStorageError;
      const status = error instanceof DownloadError ? downloadErrorStatus(error) : error instanceof HttpError || error instanceof BusyError || error instanceof ConflictError ? error.status : error instanceof SettingsValidationError ? 400 : 500;
      if (error instanceof BusyError) response.setHeader('Retry-After', '15');
      if (!expected) {
        // Unexpected failures answer with a generic message; log enough to place them.
        const e = error as Partial<Error> & { code?: unknown };
        const trace = (e.stack ?? '').split('\n').slice(1, 4).map(line => line.trim()).join(' <- ');
        const url = request.url ? new URL(request.url, 'http://x').pathname.replace(/\/addon\/[^/]+/, '/addon/[redacted]').replace(/\/play\/[^/]+/, '/play/[redacted]') : '?';
        log.error(`Debridarr ${request.method} ${url} failed: requestId=${id} ${typeof e.code === 'string' ? `${e.code} ` : ''}${e.name ?? 'Error'}: ${e.message ?? String(error)}${trace ? ` | ${trace}` : ''}`);
      }
      const message = expected ? (error as Error).message : 'An internal error occurred';
      json(response, status, { error: message, requestId: id });
    });
  });
}
