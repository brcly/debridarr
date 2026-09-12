import { clientAddress } from '../security/clientAddress.js';
import { transferServiceFor } from '../application/factory.js';
import { diagnostics } from './diagnostics.js';
import { retentionStatus } from '../retention/status.js';
import { retryDownload } from '../downloads/recovery.js';
import { tokenOptions } from '../store/access.js';
import { ConflictError } from '../downloads/coordinator.js';
import { BusyError } from '../security/admission.js';
import { sourceIdentity } from '../security/addon.js';
import { deleteManaged } from '../downloads/deletion.js';
import { admitQueuedTransfers } from '../downloads/queue.js';
import type { DownloadRecord, RecordMedia } from '../downloads/store.js';
import type { DownloadsRepository, SettingsRepository, AddonAccessRepository, StoreAccessRepository } from '../state/repositories.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import { applySettingsPatch, publicSettings, type Settings } from '../settings.js';
import { DownloadError } from '../downloads/manager.js';
import { backendSnapshot, invalidateBackendSnapshot } from '../backends/snapshot.js';
import { TransferError, sourceName, type TransferSource } from '../application/transfers.js';
import { body, HttpError, json } from '../http.js';
import { parseStoreAdd } from '../store/input.js';
import { createMetadataProvider } from '../metadata/index.js';
import { clearDownloadBackends, createDownloadBackend } from '../backends/factory.js';
import { fetchTorrentSource } from '../security/torrentSource.js';
import type { TorrentSnapshot } from '../backends/torrent.js';
import { backendDescriptors, createRegisteredBackend } from '../backends/registry.js';
import { createRegisteredDiscoveryProvider, discoveryProviderDescriptors, discoveryProxyTargets } from '../discovery/registry.js';
import { activeCount, isActive } from '../playback/active.js';
import { COOKIE_NAME, cookieValue, sessionCookie, Sessions, validCsrf } from './auth.js';
import { ADMIN_ACTION_TIMEOUT_MS } from '../timeouts.js';
import { requestCounters } from '../metrics.js';
import type { Admission } from '../security/admission.js';
import { objectRecord } from '../json.js';
import { pollSavedSearch } from '../rss/poll.js';
import { allSavedSearchStatus, recordItem, savedSearchStatus } from '../rss/state.js';

const HASH_PATH = /^\/api\/admin\/downloads\/([a-f0-9]{40})$/i;
const RSS_ACTION_PATH = /^\/api\/admin\/rss\/([a-z0-9][a-z0-9-]{0,63})\/(poll|ignore)$/;

function record(value: unknown): Record<string, unknown> {
  return objectRecord(value) ?? {};
}

// A readable name for the record and its Stremio label: the .torrent's own
// name or the magnet's display name (scene names parse into a rich label),
// else the resolved title, else the id.
async function storeItemName(source: TransferSource, media: RecordMedia | undefined, settings: Settings, signal: AbortSignal): Promise<string | undefined> {
  const name = sourceName(source);
  if (name) return name;
  if (media) {
    try {
      const resolved = await createMetadataProvider(settings.metadata).resolve(media, signal);
      if (resolved.title) return resolved.title;
    } catch { /* best effort — a name is not worth failing the add over */ }
    return media.imdbId;
  }
  return undefined;
}

function downloadView(record: DownloadRecord, torrent: TorrentSnapshot | undefined, retention?: Settings['retention']) {
  return {
    ...(retention ? { retentionStatus: retentionStatus(record, torrent, retention, isActive(record.infoHash)) } : {}),
    lifecycle: record.lifecycle ?? 'legacy', failure: record.failure ?? null, origin: record.origin,
    infoHash: record.infoHash, name: record.name,
    imdbId: record.media?.imdbId ?? null, type: record.media?.type ?? null,
    ...(record.media?.season === undefined ? {} : { season: record.media.season }),
    ...(record.media?.episode === undefined ? {} : { episode: record.media.episode }),
    bytes: record.bytes, addedAt: record.addedAt, expiresAt: record.expiresAt, kept: record.kept,
    ratio: torrent?.ratio ?? null, progress: torrent?.progress ?? null, state: torrent?.state ?? null, eta: torrent?.eta ?? null,
  };
}

export function createAdminRoutes(config: Config, store: SettingsRepository, downloads?: DownloadsRepository, sessions = new Sessions(config.adminPassword), access?: Promise<AddonAccessRepository>, storeAccess?: Promise<StoreAccessRepository>, searches?: Admission, streams?: Admission) {
  const origin = new URL(config.appUrl);
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    if (request.headers.host !== origin.host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin.origin)) {
      throw new HttpError(403, `Open the administration site at ${origin.origin}/configure (this request used ${request.headers.host ?? 'an unknown host'}).`);
    }
    const mutation = request.method !== 'GET' && request.method !== 'HEAD';
    if (mutation && request.headers.origin !== origin.origin) throw new HttpError(403, 'Origin verification failed');
    const token = cookieValue(request.headers.cookie, COOKIE_NAME);
    if (pathname === '/api/admin/login' && request.method === 'POST') {
      const input = await body(request);
      if (!input || typeof input !== 'object' || !('password' in input) || typeof input.password !== 'string') {
        throw new HttpError(400, 'Enter an administrator password');
      }
      const result = await sessions.login(input.password, clientAddress(request));
      if (result === 'busy') {
        response.setHeader('Retry-After', '1');
        throw new HttpError(503, 'Login verification is busy. Try again shortly.');
      }
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
    if (mutation && !validCsrf(request.headers['x-csrf-token'], session.csrfToken)) throw new HttpError(403, 'Session verification failed. Reload and try again.');
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
    } else if (pathname === '/api/admin/store/tokens' || pathname.startsWith('/api/admin/store/tokens/')) {
      const tokens = await storeAccess;
      if (!tokens) throw new HttpError(503, 'Token storage unavailable');
      if (pathname === '/api/admin/store/tokens' && request.method === 'GET') json(response, 200, { tokens: tokens.list() });
      else if (pathname === '/api/admin/store/tokens' && request.method === 'POST') {
        let options;
        const input = await body(request);
        try { options = tokenOptions(input); } catch (error) { throw new HttpError(400, (error as Error).message); }
        json(response, 201, await tokens.create(options));
      } else if (/^\/api\/admin\/store\/tokens\/[a-f0-9]{32}$/.test(pathname) && request.method === 'DELETE') {
        await tokens.revoke(pathname.split('/').at(-1)!);
        json(response, 200, { ok: true });
      } else throw new HttpError(404, 'Not found');
    } else if (pathname === '/api/admin/settings' && request.method === 'GET') {
      json(response, 200, {
        settings: publicSettings(store.snapshot()),
        backends: backendDescriptors(),
        discoveryProviders: discoveryProviderDescriptors(),
        deployment: { appUrl: config.appUrl, port: config.port, downloadDir: config.downloadDir },
      });
    } else if (pathname === '/api/admin/settings' && request.method === 'PATCH') {
      const previous = sourceIdentity(store.snapshot().discovery.providers);
      const previousBackend = store.snapshot().downloadBackend.id;
      const settings = await store.update(await body(request));
      clearDownloadBackends();
      invalidateBackendSnapshot(previousBackend);
      if (sourceIdentity(settings.discovery.providers) !== previous) await (await access)?.invalidate();
      json(response, 200, { settings: publicSettings(settings) });
    } else if (pathname === '/api/admin/test/downloadBackend' && request.method === 'POST') {
      const draft = applySettingsPatch(store.snapshot(), { downloadBackend: await body(request) });
      json(response, 200, await createRegisteredBackend(draft.downloadBackend).test());
    } else if (pathname === '/api/admin/test/discovery' && request.method === 'POST') {
      const draft = record(await body(request));
      // A provider under test may reuse the saved key (the form posts no
      // secret when the field is left on "keep"). null explicitly tests it
      // without a key, matching the settings PATCH contract.
      const patched = applySettingsPatch(store.snapshot(), { discovery: { providers: [{
        ...(typeof draft.id === 'string' && draft.id ? { id: draft.id } : {}),
        type: draft.type, url: typeof draft.url === 'string' ? draft.url : '',
        ...(Object.hasOwn(draft, 'apiKey') ? { apiKey: draft.apiKey } : {}),
      }] } });
      json(response, 200, await createRegisteredDiscoveryProvider(patched.discovery.providers[0]!).test());
    } else if (pathname === '/api/admin/diagnostics' && request.method === 'GET') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      json(response, 200, await diagnostics(config, store.snapshot(), downloads));
    } else if (pathname === '/api/admin/metrics' && request.method === 'GET') {
      const byLifecycle: Record<string, number> = {};
      for (const record of downloads?.list() ?? []) {
        const key = record.lifecycle ?? 'managed';
        byLifecycle[key] = (byLifecycle[key] ?? 0) + 1;
      }
      json(response, 200, {
        uptimeSeconds: Math.round(process.uptime()),
        requests: requestCounters(),
        playback: { active: activeCount() },
        admission: { searches: searches?.snapshot(), streams: streams?.snapshot() },
        downloads: byLifecycle,
      });
    } else if (pathname === '/api/admin/rss/status' && request.method === 'GET') {
      json(response, 200, { status: allSavedSearchStatus() });
    } else if (RSS_ACTION_PATH.test(pathname) && request.method === 'POST') {
      const settings = store.snapshot();
      if (settings.integrations.mode === 'search') throw new HttpError(403, 'Switch to Store or Both mode on the Connections tab to use saved searches.');
      const [, searchId, action] = RSS_ACTION_PATH.exec(pathname)!;
      const search = settings.rss.searches.find(candidate => candidate.id === searchId);
      if (!search) throw new HttpError(404, 'Unknown saved search');
      if (action === 'poll') {
        if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
        await pollSavedSearch(search, settings, createDownloadBackend(settings.downloadBackend), downloads);
      } else {
        const input = objectRecord(await body(request));
        if (!input || typeof input.guid !== 'string' || !input.guid) throw new HttpError(400, 'guid is required');
        const title = savedSearchStatus(searchId!)?.items.find(item => item.guid === input.guid)?.title ?? '';
        recordItem(searchId!, { guid: input.guid, title, status: 'ignored' });
      }
      json(response, 200, { status: savedSearchStatus(searchId!) ?? { items: [] } });
    } else if (/^\/api\/admin\/downloads\/[a-f0-9]{40}\/(retry|pause|resume)$/i.test(pathname) && request.method === 'POST') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const parts = pathname.split('/');
      const hash = parts[4]!;
      const action = parts[5]!.toLowerCase();
      if (action === 'retry') {
        json(response, 200, await retryDownload(hash, { store, downloads }));
      } else {
        const settings = store.snapshot();
        const service = transferServiceFor({ settings, downloads });
        try {
          await service.setRunning(hash, action === 'resume');
          json(response, 200, { ok: true });
        } catch (error) {
          if (error instanceof TransferError) throw new HttpError(error.code === 'not_found' ? 404 : error.code === 'bad_source' ? 400 : 503, error.message);
          throw error;
        }
      }
    } else if (/^\/api\/admin\/downloads\/[a-f0-9]{40}\/files(?:\/\d+\/(select|go))?$/i.test(pathname)) {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const settings = store.snapshot();
      const parts = pathname.split('/');
      const isGo = parts[7] === 'go';
      // Only the permalink needs to mint a signed /api/v1/download/ URL; the
      // dashboard's own session cookie is what makes GET-ing this route work.
      const service = transferServiceFor({
        settings, downloads,
        ...(isGo ? { links: { appUrl: config.appUrl, linkSecret: (await storeAccess)!.linkSecret() } } : {}),
      });
      try {
        if (request.method === 'GET' && parts.length === 6) json(response, 200, { files: await service.files(parts[4]!) });
        else if (request.method === 'POST' && parts[7] === 'select') json(response, 200, { file: await service.select(parts[4]!, parts[6]!) });
        else if (request.method === 'GET' && isGo) {
          const [link] = await service.links(parts[4]!, parts[6]!);
          response.writeHead(302, { Location: link!.url }).end();
        }
        else throw new HttpError(405, 'Method not allowed');
      } catch (error) {
        if (error instanceof TransferError) throw new HttpError(error.code === 'not_found' ? 404 : error.code === 'bad_source' ? 400 : 503, error.message);
        throw error;
      }
    } else if (pathname === '/api/admin/downloads' && request.method === 'GET') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const backend = createDownloadBackend(store.snapshot().downloadBackend);
      const snap = await backendSnapshot(backend).catch(() => undefined);
      json(response, 200, { downloads: downloads.list().map(record => downloadView(record, snap?.byHash.get(record.infoHash), store.snapshot().retention)), upstreamAvailable: snap !== undefined });
    } else if (pathname === '/api/admin/downloads' && request.method === 'POST') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const settings = store.snapshot();
      if (settings.integrations.mode === 'search') throw new HttpError(403, 'Switch to Store or Both mode on the Connections tab to add torrents directly.');
      const { source, media, keep, name: suppliedName } = parseStoreAdd(await body(request, 4 * 1024 * 1024));
      const service = transferServiceFor({ settings, downloads, resolveSources: true });
      // The admin panel enriches the name with a resolved title; the service
      // otherwise derives one from the magnet/.torrent itself.
      const name = suppliedName ?? await storeItemName(source, media, settings, AbortSignal.timeout(ADMIN_ACTION_TIMEOUT_MS));
      try {
        const { item, pending } = await service.add({ source, ...(name ? { name } : {}), ...(media ? { media } : {}) });
        if (keep) await downloads.setKept(item.id, true).catch(() => {});
        json(response, pending ? 202 : 201, {
          download: downloadView(downloads.get(item.id)!, undefined), ...(pending ? { pending: true } : {}),
        });
      } catch (error) {
        if (error instanceof ConflictError || error instanceof BusyError || error instanceof DownloadError) throw error;
        if (error instanceof TransferError) throw new HttpError(error.code === 'bad_source' ? 400 : error.code === 'not_configured' ? 503 : 502, error.message);
        throw new HttpError(502, 'Could not add the torrent. Check the download backend.');
      }
    } else if (hashMatch && request.method === 'PATCH') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const input = objectRecord(await body(request));
      if (!input || typeof input.kept !== 'boolean') {
        throw new HttpError(400, 'kept must be a boolean');
      }
      const record = await downloads.setKept(hashMatch[1]!, input.kept);
      if (!record) throw new HttpError(404, 'Unknown download');
      json(response, 200, { download: downloadView(record, undefined) });
    } else if (hashMatch && request.method === 'DELETE') {
      if (!downloads) throw new HttpError(503, 'Downloads are unavailable');
      const infoHash = hashMatch[1]!;
      if (!downloads.get(infoHash)) throw new HttpError(404, 'Unknown download');
      if (isActive(infoHash)) throw new HttpError(409, 'This title is currently being streamed');
      const backend = createDownloadBackend(store.snapshot().downloadBackend);
      try { await deleteManaged(downloads, backend, infoHash, AbortSignal.timeout(ADMIN_ACTION_TIMEOUT_MS)); }
      catch (error) {
        if (error instanceof ConflictError || error instanceof BusyError || error instanceof DownloadError) throw error;
        throw new HttpError(502, 'Deletion could not be confirmed. The download remains tracked; retry after checking the download backend.');
      }
      invalidateBackendSnapshot(backend.identity);
      const settings = store.snapshot();
      await admitQueuedTransfers({
        downloads, backend,
        leaseDays: settings.retention.storeLeaseDays,
        maxActiveDownloads: settings.store.maxActiveDownloads,
        minFreeSpaceGB: settings.retention.minFreeSpaceGB,
        sourceResolver: (url, signal) => fetchTorrentSource(url, signal, discoveryProxyTargets(settings)),
      });
      json(response, 200, { ok: true });
    } else {
      throw new HttpError(404, 'Not found');
    }
  };
}
