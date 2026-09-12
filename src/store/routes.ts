import { clientAddress } from '../security/clientAddress.js';
import { DownloadError, downloadErrorStatus } from '../downloads/manager.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, bytes, HttpError, json } from '../http.js';
import { MAX_TORRENT, parseStoreAdd } from './input.js';
import { ConflictError } from '../downloads/coordinator.js';
import { magnetInfoHash } from '../downloads/magnet.js';
import { validateMagnet } from '../security/torrentSource.js';
import { BusyError } from '../security/admission.js';
import { StoreAuthThrottle, type StoreToken, type TokenScope } from './access.js';
import type { StoreAccessRepository } from '../state/repositories.js';
import { TransferError, type Transfer, type TransferFile, type TransferLink, type TransferService, type TransferStatus } from '../application/transfers.js';
import { isRealDebridPath, RdError, rdErrorCode, rdErrorStatus, realdebridRoutes } from './realdebrid.js';
import { parseHex40 } from '../domain/ids.js';

const scopeVerb: Record<TokenScope, string> = { read: 'read from', write: 'modify', link: 'create links for' };
function requireScope(token: StoreToken, scope: TokenScope): void {
  if (!token.scopes.includes(scope)) throw new HttpError(403, `This token cannot ${scopeVerb[scope]} the store.`);
}
export const isStorePath = (path: string) => path === '/store' || path.startsWith('/store/') || path === '/v0/store' || path.startsWith('/v0/store/') || path === '/v0/health' || path === '/rest/1.0' || path.startsWith('/rest/1.0/');
const isAdapter = (path: string) => path.startsWith('/store/stremthru/') || path.startsWith('/v0/');

function hash(value: string): string {
  let result: string | undefined;
  try { result = parseHex40(value) ?? magnetInfoHash(validateMagnet(value)); } catch { /* invalid source */ }
  if (!result) throw new HttpError(400, 'Use a 40-character infohash or a magnet.');
  return result;
}
function hashes(values: string[], maximum = 100): string[] {
  const items = values.flatMap(value => value.split(',')).map(value => value.trim());
  if (!items.length || items.length > maximum || items.some(v => !v)) throw new HttpError(400, `Provide 1–${maximum} hashes.`);
  return items.map(hash);
}
function integer(value: string | null, fallback: number, maximum: number, minimum = 0): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new HttpError(400, 'Invalid pagination.');
  return Number(value);
}
async function addInput(request: IncomingMessage, adapter: boolean) {
  const contentType = request.headers['content-type'] ?? '';
  const type = contentType.split(';')[0]?.trim();
  if (type === 'application/x-bittorrent') {
    return { source: { torrent: await bytes(request, MAX_TORRENT) } };
  }
  if (type === 'application/x-nzb') {
    return { source: { nzb: await bytes(request, MAX_TORRENT) } };
  }
  if (adapter && contentType.startsWith('multipart/form-data;')) {
    const raw = await bytes(request, MAX_TORRENT + 65536);
    let form: FormData;
    try { form = await new Response(new Uint8Array(raw), { headers: { 'Content-Type': contentType } }).formData(); }
    catch { throw new HttpError(400, 'Invalid torrent upload.'); }
    const torrent = form.get('torrent');
    if (!(torrent instanceof File) || form.getAll('torrent').length !== 1 || torrent.size > MAX_TORRENT) throw new HttpError(400, 'Upload one .torrent file up to 2 MiB.');
    return { source: { torrent: Buffer.from(await torrent.arrayBuffer()) } };
  }
  const input = await body(request, 3 * 1024 * 1024);
  if (adapter && input && typeof input === 'object' && 'torrent' in input) {
    throw new HttpError(400, 'Torrent URLs are unsupported; upload a .torrent file or send a magnet.');
  }
  return parseStoreAdd(input);
}
const statusName = (status: TransferStatus | undefined) => ({ ready: 'downloaded', downloading: 'downloading', queued: 'queued', missing: 'unknown', error: 'failed' })[status?.state ?? 'missing'];
const fileLink = (hash: string, id: string) => `debridarr:${hash}:${id}`;
const storeItemView = ({ id, ...item }: Transfer) => ({ infoHash: id, ...item });
const storeFileView = ({ path, ...file }: TransferFile) => ({ ...file, name: path });
const storeLinkView = (link: TransferLink) => ({ ...link, file: storeFileView(link.file) });
function magnetView(service: TransferService, item: Transfer, status: TransferStatus | undefined, files: boolean, available = service.selectedFiles(item.id)) {
  return {
    id: item.id, hash: item.id, name: item.name, size: item.bytes,
    added_at: new Date(item.addedAt).toISOString(), status: item.lifecycle === 'registering' ? 'processing' : statusName(status),
    magnet: `magnet:?xt=urn:btih:${item.id}`,
    ...(files ? { files: available.filter(f => f.video).map(f => ({
      index: Number(f.id), name: f.path.split('/').at(-1)!, path: f.path, size: f.bytes, link: fileLink(item.id, f.id),
    })) } : {}),
  };
}
async function adapterRoutes(request: IncomingMessage, response: ServerResponse, url: URL, service: TransferService, token: StoreToken) {
  const path = url.pathname.replace(/^\/store\/stremthru(?:\/v0)?/, '/v0');
  const send = (data: unknown) => json(response, 200, { data });
  if (path === '/v0/health' && request.method === 'GET') { send({ status: 'ok' }); return; }
  // The shorter documented prefix also accepts /magnets, /user and /link/generate.
  const route = path.replace(/^\/v0\/(?:store\/)?/, '/');
  if (route === '/user' && request.method === 'GET') { requireScope(token, 'read'); send({ id: token.id, email: '', subscription_status: 'premium' }); return; }
  if (route === '/magnets/check' && request.method === 'GET') {
    requireScope(token, 'read');
    const wanted = hashes(url.searchParams.getAll('magnet'), 500);
    const statuses = await service.status(wanted);
    send({ items: wanted.map(hash => {
      const item = service.get(hash);
      const ready = statuses[hash]?.state === 'ready';
      return { hash, magnet: `magnet:?xt=urn:btih:${hash}`, status: ready ? 'cached' : statusName(statuses[hash]),
        ...(item ? { name: item.name } : {}),
        files: ready ? service.selectedFiles(hash).filter(f => f.video).map(f => ({ index: Number(f.id), name: f.path.split('/').at(-1)!, path: f.path, size: f.bytes })) : [],
      };
    }) });
    return;
  }
  if (route === '/magnets' && request.method === 'POST') {
    requireScope(token, 'write');
    const { item } = await service.add(await addInput(request, true));
    const statuses = await service.status([item.id]);
    send(magnetView(service, item, statuses[item.id], true, await service.files(item.id))); return;
  }
  if (route === '/magnets' && request.method === 'GET') {
    requireScope(token, 'read');
    const all = service.list();
    const offset = integer(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(url.searchParams.get('limit'), 100, 500, 1);
    const page = all.slice(offset, offset + limit);
    const statuses = page.length ? await service.status(page.map(i => i.id)) : {};
    send({ items: page.map(i => magnetView(service, i, statuses[i.id], false)), total_items: all.length }); return;
  }
  const match = /^\/magnets\/([a-f0-9]{40})$/i.exec(route);
  if (match) {
    const id = hash(match[1]!);
    if (request.method === 'DELETE') { requireScope(token, 'write'); await service.remove(id); send(null); return; }
    if (request.method === 'GET') {
      requireScope(token, 'read');
      const item = service.get(id);
      if (!item) throw new HttpError(404, 'No such stored torrent.');
      const statuses = await service.status([id]);
      send(magnetView(service, item, statuses[id], true, await service.files(id))); return;
    }
  }
  if (route === '/link/generate' && request.method === 'POST') {
    requireScope(token, 'link');
    const input = await body(request) as { link?: unknown } | null;
    const match = typeof input?.link === 'string' && /^debridarr:([a-f0-9]{40}):(0|[1-9][0-9]{0,8})$/.exec(input.link);
    if (!match) throw new HttpError(400, 'Use a file link returned by this store.');
    send({ link: (await service.link(match[1]!, match[2]!)).url }); return;
  }
  throw new HttpError(404, 'Not found');
}

export async function storeRoutes(request: IncomingMessage, response: ServerResponse, url: URL, access: StoreAccessRepository, service: () => Promise<TransferService>): Promise<void> {
  const adapter = isAdapter(url.pathname);
  const realdebrid = isRealDebridPath(url.pathname);
  let release: (() => void) | undefined;
  try {
    const authorization = request.headers.authorization ?? (adapter ? request.headers['x-stremthru-store-authorization'] : undefined);
    const bearer = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] : undefined;
    const token = await access.authenticate(bearer ?? '', clientAddress(request));
    if (!token) { response.setHeader('WWW-Authenticate', 'Bearer'); throw new HttpError(401, 'A valid store token is required.'); }
    release = access.enter(token);
    const store = await service();
    if (adapter) { await adapterRoutes(request, response, url, store, token); return; }
    if (realdebrid) { await realdebridRoutes(request, response, url, store, token); return; }
    const route = url.pathname.slice('/store/v1'.length);
    if (!url.pathname.startsWith('/store/v1/')) throw new HttpError(404, 'Not found');
    if (route === '/magnets' && request.method === 'POST') {
      requireScope(token, 'write');
      const result = await store.add(await addInput(request, false));
      json(response, result.pending ? 202 : 201, { ...result, item: storeItemView(result.item) }); return;
    }
    if (route === '/magnets' && request.method === 'GET') {
      requireScope(token, 'read');
      json(response, 200, url.searchParams.has('hash') ? { statuses: await store.status(hashes(url.searchParams.getAll('hash'))) } : { items: store.list().map(storeItemView) }); return;
    }
    const match = /^\/magnets\/([a-f0-9]{40})(?:\/(files)(?:\/(0|[1-9][0-9]{0,8})\/(link|select))?)?$/i.exec(route);
    if (match) {
      const id = hash(match[1]!);
      if (!match[2] && request.method === 'DELETE') { requireScope(token, 'write'); await store.remove(id); json(response, 200, { ok: true }); return; }
      if (!match[2] && request.method === 'GET') {
        requireScope(token, 'read');
        const item = store.get(id);
        if (!item) throw new HttpError(404, 'No such stored torrent.');
        json(response, 200, { item: storeItemView(item) }); return;
      }
      if (match[2] && !match[3] && request.method === 'GET') { requireScope(token, 'read'); json(response, 200, { files: (await store.files(id)).map(storeFileView) }); return; }
      if (match[3] && request.method === 'POST') {
        requireScope(token, match[4] === 'select' ? 'write' : 'link');
        json(response, 200, match[4] === 'select' ? { file: storeFileView(await store.select(id, match[3])) } : storeLinkView(await store.link(id, match[3]))); return;
      }
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    const rawStatus = error instanceof RdError ? error.status
      : error instanceof HttpError || error instanceof BusyError || error instanceof ConflictError ? error.status
      : error instanceof DownloadError ? downloadErrorStatus(error) : error instanceof TransferError ? ({ not_found: 404, bad_source: 400, unavailable: 503, not_configured: 503 })[error.code] : 502;
    const status = realdebrid ? rdErrorStatus(rawStatus) : rawStatus;
    const message = error instanceof RdError || error instanceof HttpError || error instanceof BusyError || error instanceof ConflictError || error instanceof TransferError || error instanceof DownloadError ? error.message : 'Store request failed. Check the download backend and storage.';
    if (status === 429) response.setHeader('Retry-After', error instanceof StoreAuthThrottle ? String(error.retryAfter) : '60');
    if (realdebrid) {
      json(response, status, { error: status === 401 ? 'bad_token' : message, error_code: rdErrorCode(error, rawStatus) });
      return;
    }
    const code = ({ 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'BAD_REQUEST', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'TOO_MANY_REQUESTS', 502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE', 507: 'INSUFFICIENT_STORAGE' } as Record<number, string>)[status] ?? 'UNKNOWN';
    json(response, status, { error: adapter ? { code, message, type: 'store_error' } : message });
  } finally { release?.(); }
}
