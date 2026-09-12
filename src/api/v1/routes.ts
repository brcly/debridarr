import { clientAddress } from '../../security/clientAddress.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, bytes, json } from '../../http.js';
import { MAX_TORRENT, parseStoreAdd } from '../../store/input.js';
import { type StoreToken, type TokenScope } from '../../store/access.js';
import type { StoreAccessRepository } from '../../state/repositories.js';
import type { Settings } from '../../settings.js';
import type { DownloadBackend } from '../../backends/download.js';
import type { Transfer, TransferMedia, TransferSource } from '../../application/types.js';
import type { TransferService } from '../../application/transfers.js';
import { configuredDiscoverySources } from '../../discovery/registry.js';
import { createMetadataProvider, parseMediaId } from '../../metadata/index.js';
import { findReleases, type Candidate } from '../../search/index.js';
import { ApiError, sendApiError, toApiError } from './errors.js';
import { IDEMPOTENCY_KEY, IdempotencyCache, type StoredResponse } from './idempotency.js';
import { LINK_TTL_MS } from './links.js';
import { openApiDocument } from './openapi.js';
import { streamTransferZip } from '../../playback/zip.js';
import { HEX40, isHex40 } from '../../domain/ids.js';
import { DISCOVER_DEADLINE_MS } from '../../timeouts.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// The one route a bare hyperlink (media player, bookmark) can authenticate:
// a permalink cannot set an Authorization header, so it alone accepts the
// token as a query parameter instead.
const GO_PATH = /^\/api\/v1\/transfers\/[a-fA-F0-9]{40}\/files\/(0|[1-9][0-9]{0,8})\/go$/;
const BATCH_MAX = 100;
const LIST_MAX = 200;

export interface ApiV1ServiceView {
  service: TransferService;
  backend: DownloadBackend;
  settings: Settings;
  downloadDir: string;
}

export interface ApiV1Deps {
  storeAccess: StoreAccessRepository;
  idempotency: IdempotencyCache;
  // False in `search` mode: the native API needs a download backend front door.
  enabled: boolean;
  service: () => Promise<ApiV1ServiceView>;
  now?: () => number;
}

export const isApiV1Path = (pathname: string): boolean => pathname === '/api/v1' || pathname.startsWith('/api/v1/');

export async function apiV1Routes(request: IncomingMessage, response: ServerResponse, url: URL, deps: ApiV1Deps): Promise<void> {
  if (url.pathname === '/api/v1/openapi.json') {
    if (request.method !== 'GET' && request.method !== 'HEAD') { sendApiError(response, new ApiError('method_not_allowed', 'Use GET.')); return; }
    json(response, 200, openApiDocument);
    return;
  }
  let release: (() => void) | undefined;
  try {
    if (!deps.enabled) throw new ApiError('not_found', 'The native API requires Store or Both mode.');
    const header = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const queryToken = !header && GO_PATH.test(url.pathname) ? url.searchParams.get('token') : null;
    const bearer = header ?? (queryToken && TOKEN_SHAPE.test(queryToken) ? queryToken : undefined);
    const token = await deps.storeAccess.authenticate(bearer ?? '', clientAddress(request));
    if (!token) { response.setHeader('WWW-Authenticate', 'Bearer'); throw new ApiError('unauthorized', 'A valid API token is required.'); }
    release = deps.storeAccess.enter(token);
    await route(request, response, url, token, deps);
  } catch (error) {
    // The zip route may have already started streaming; headers are
    // committed by then and a second writeHead would throw.
    if (response.headersSent) { response.destroy(); return; }
    sendApiError(response, toApiError(error));
  } finally {
    release?.();
  }
}

function requireScope(token: StoreToken, scope: TokenScope): void {
  if (!token.scopes.includes(scope)) throw new ApiError('forbidden', `This token is missing the "${scope}" scope.`);
}

function limitParam(value: string | null): number {
  if (value === null) return 50;
  if (!/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > LIST_MAX) throw new ApiError('invalid_request', `limit must be a whole number between 1 and ${LIST_MAX}.`);
  return Number(value);
}

const encodeCursor = (item: Transfer): string => Buffer.from(`${item.addedAt}:${item.id}`).toString('base64url');
function decodeCursor(raw: string): { addedAt: number; id: string } {
  const [head, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split(':');
  const addedAt = Number(head);
  const id = rest.join(':');
  if (!head || !Number.isFinite(addedAt) || !isHex40(id)) throw new ApiError('invalid_request', 'Invalid cursor.');
  return { addedAt, id };
}

function parseIds(value: string[]): string[] {
  const list = value.flatMap(entry => entry.split(',')).map(entry => entry.trim());
  if (!list.length || list.length > BATCH_MAX || list.some(entry => !HEX40.test(entry))) throw new ApiError('invalid_request', `Provide 1–${BATCH_MAX} infohashes via repeated or comma-separated "ids".`);
  return list.map(entry => entry.toLowerCase());
}

async function readCreateInput(request: IncomingMessage): Promise<{ source: TransferSource; media?: TransferMedia; name?: string; queue?: boolean; cachedOnly?: boolean }> {
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim();
  if (contentType === 'application/x-bittorrent') {
    return { source: { torrent: await bytes(request, MAX_TORRENT) } };
  }
  if (contentType === 'application/x-nzb') {
    return { source: { nzb: await bytes(request, MAX_TORRENT) } };
  }
  const parsed = parseStoreAdd(await body(request, 3 * 1024 * 1024));
  return {
    source: parsed.source,
    ...(parsed.media ? { media: parsed.media } : {}),
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.queue ? { queue: true } : {}),
    ...(parsed.cachedOnly ? { cachedOnly: true } : {}),
  };
}

async function route(request: IncomingMessage, response: ServerResponse, url: URL, token: StoreToken, deps: ApiV1Deps): Promise<void> {
  const { pathname } = url;
  const method = request.method ?? 'GET';
  const now = deps.now ?? Date.now;

  if (pathname === '/api/v1/capabilities') {
    if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
    requireScope(token, 'read');
    const { backend, settings } = await deps.service();
    json(response, 200, {
      token: { id: token.id, scopes: token.scopes, quotas: token.quotas },
      backend: {
        configured: backend.configured,
        input: {
          magnet: backend.protocol === 'torrent',
          torrent: backend.protocol === 'torrent',
          infoHash: backend.protocol === 'torrent',
          nzb: backend.protocol === 'usenet',
        },
        fileSelection: true,
        freeSpace: !!backend.capabilities.freeSpace,
        seedPolicy: !!backend.capabilities.seedLimits,
        sequentialDownload: !!backend.capabilities.downloadOrder,
        verifiedPieces: !!backend.capabilities.pieces,
        queue: true,
        cachedOnly: true,
        pause: true,
        preview: true,
        permalink: true,
        zip: true,
      },
      limits: {
        maxActiveDownloads: settings.store.maxActiveDownloads,
        leaseDays: settings.retention.storeLeaseDays,
        batchStatusMax: BATCH_MAX,
        maxTransferListLimit: LIST_MAX,
        maxTorrentBytes: MAX_TORRENT,
        linkTtlSeconds: LINK_TTL_MS / 1000,
      },
    });
    return;
  }

  if (pathname === '/api/v1/discover') {
    if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
    requireScope(token, 'read');
    const type = url.searchParams.get('type');
    const imdbId = url.searchParams.get('imdbId');
    if (type !== 'movie' && type !== 'series') throw new ApiError('invalid_request', 'type must be movie or series.');
    if (type === 'movie' && (url.searchParams.has('season') || url.searchParams.has('episode'))) {
      throw new ApiError('invalid_request', 'season and episode apply to series only.');
    }
    const suffix = type === 'series' ? `:${url.searchParams.get('season') ?? ''}:${url.searchParams.get('episode') ?? ''}` : '';
    const mediaId = parseMediaId(type, `${imdbId ?? ''}${suffix}`);
    if (!mediaId) throw new ApiError('invalid_request', 'Provide a valid imdbId; series also needs season and episode.');
    const limit = limitParam(url.searchParams.get('limit'));
    const { settings, backend } = await deps.service();
    const sources = configuredDiscoverySources(settings);
    if (!sources.some(({ source }) => source.configured)) { json(response, 200, { releases: [] }); return; }
    // All sources and queries run concurrently under one signal; a discover
    // request must not hold a connection open indefinitely.
    const signal = AbortSignal.timeout(DISCOVER_DEADLINE_MS);
    let candidates: Candidate[];
    try {
      candidates = await findReleases({
        id: mediaId, metadata: createMetadataProvider(settings.metadata), sources, signal, limit,
        protocols: [backend.protocol],
      });
    } catch {
      throw new ApiError('bad_gateway', signal.aborted ? 'Discovery timed out.' : 'Discovery failed upstream.');
    }
    json(response, 200, { releases: candidates.map(candidate => candidate.release) });
    return;
  }

  if (pathname === '/api/v1/transfers') {
    const { service } = await deps.service();
    if (method === 'POST') {
      requireScope(token, 'write');
      const input = await readCreateInput(request);
      const create = async (): Promise<StoredResponse> => {
        const { item, pending } = await service.add(input);
        return { status: pending ? 202 : 201, body: { transfer: item } };
      };
      const key = request.headers['idempotency-key'];
      if (key !== undefined) {
        if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) throw new ApiError('invalid_request', 'Idempotency-Key must be 1–255 characters of [A-Za-z0-9._-].');
        const { response: stored, replay } = await deps.idempotency.run(token.id, key, create);
        sendCreated(response, stored, replay);
        return;
      }
      sendCreated(response, await create(), false);
      return;
    }
    if (method === 'GET') {
      requireScope(token, 'read');
      const limit = limitParam(url.searchParams.get('limit'));
      // Deterministic order independent of the store's intra-timestamp order:
      // newest first, infohash ascending as the tie-break the cursor relies on.
      let items = service.list().sort((a, b) => b.addedAt - a.addedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const cursor = url.searchParams.get('cursor');
      if (cursor) {
        const after = decodeCursor(cursor);
        items = items.filter(item => item.addedAt < after.addedAt || (item.addedAt === after.addedAt && item.id > after.id));
      }
      const page = items.slice(0, limit);
      json(response, 200, { items: page, next_cursor: page.length === limit && items.length > limit ? encodeCursor(page[page.length - 1]!) : null });
      return;
    }
    throw new ApiError('method_not_allowed', 'Use GET or POST.');
  }

  if (pathname === '/api/v1/transfers/status') {
    if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
    requireScope(token, 'read');
    const { service } = await deps.service();
    json(response, 200, { statuses: await service.status(parseIds(url.searchParams.getAll('ids'))) });
    return;
  }

  if (pathname === '/api/v1/transfers/preview') {
    if (method !== 'POST') throw new ApiError('method_not_allowed', 'Use POST.');
    requireScope(token, 'write');
    const { service } = await deps.service();
    json(response, 200, { preview: await service.preview((await readCreateInput(request)).source) });
    return;
  }

  const detail = /^\/api\/v1\/transfers\/([a-fA-F0-9]{40})(?:\/(files|links|pause|resume|zip)|\/files\/(0|[1-9][0-9]{0,8})\/(select|link|go))?$/.exec(pathname);
  if (detail) {
    const id = detail[1]!.toLowerCase();
    const sub = detail[2];
    const fileId = detail[3];
    const fileAction = detail[4];
    const { service, backend, downloadDir } = await deps.service();

    if (!sub && !fileId) {
      if (method === 'GET') {
        requireScope(token, 'read');
        const transfer = service.get(id);
        if (!transfer) throw new ApiError('not_found', 'No such transfer.');
        json(response, 200, { transfer });
        return;
      }
      if (method === 'DELETE') {
        requireScope(token, 'write');
        await service.remove(id);
        response.writeHead(204).end();
        return;
      }
      throw new ApiError('method_not_allowed', 'Use GET or DELETE.');
    }

    if (sub === 'pause' || sub === 'resume') {
      if (method !== 'POST') throw new ApiError('method_not_allowed', 'Use POST.');
      requireScope(token, 'write');
      await service.setRunning(id, sub === 'resume');
      response.writeHead(204).end();
      return;
    }

    if (sub === 'files') {
      if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
      requireScope(token, 'read');
      json(response, 200, { files: await service.files(id) });
      return;
    }

    if (sub === 'links') {
      if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
      requireScope(token, 'link');
      const expiresAt = now() + LINK_TTL_MS;
      json(response, 200, { links: (await service.links(id)).map(link => ({ url: link.url, name: link.name, file: link.file, expiresAt })) });
      return;
    }

    if (fileId && fileAction === 'select') {
      if (method !== 'POST') throw new ApiError('method_not_allowed', 'Use POST.');
      requireScope(token, 'write');
      json(response, 200, { file: await service.select(id, fileId) });
      return;
    }

    if (fileId && fileAction === 'link') {
      if (method !== 'POST') throw new ApiError('method_not_allowed', 'Use POST.');
      requireScope(token, 'link');
      const [link] = await service.links(id, fileId);
      json(response, 200, { link: { url: link!.url, name: link!.name, file: link!.file, expiresAt: now() + LINK_TTL_MS } });
      return;
    }

    // A stable bookmark: the path never changes, but each visit mints a
    // fresh short-lived /download link, so the permalink itself never expires.
    if (fileId && fileAction === 'go') {
      if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
      requireScope(token, 'link');
      const [link] = await service.links(id, fileId);
      response.writeHead(302, { Location: link!.url }).end();
      return;
    }

    if (sub === 'zip') {
      if (method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.');
      requireScope(token, 'link');
      const disconnected = new AbortController();
      response.on('close', () => disconnected.abort());
      await streamTransferZip(response, id, { service, backend, downloadDir }, disconnected.signal);
      return;
    }
  }

  throw new ApiError('not_found', 'Unknown route.');
}

function sendCreated(response: ServerResponse, stored: StoredResponse, replay: boolean): void {
  const payload = stored.body as { transfer?: { id?: string } };
  const extra: Record<string, string> = {};
  if (payload.transfer?.id) extra.Location = `/api/v1/transfers/${payload.transfer.id}`;
  if (replay) extra['Idempotency-Replay'] = 'true';
  json(response, stored.status, stored.body, extra);
}
