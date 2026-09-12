import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, bytes, json } from '../http.js';
import { objectRecord } from '../json.js';
import { MAX_TORRENT } from './input.js';
import { validateMagnet } from '../security/torrentSource.js';
import { parseInfoHash } from '../downloads/torrentFile.js';
import type { StoreToken, TokenScope } from './access.js';
import { TransferError, type Transfer, type TransferFile, type TransferService, type TransferStatus } from '../application/transfers.js';
import { parseHex40 } from '../domain/ids.js';

export class RdError extends Error {
  readonly status: number;
  readonly errorCode: number;
  constructor(status: number, errorCode: number, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export const isRealDebridPath = (path: string) => path === '/rest/1.0' || path.startsWith('/rest/1.0/') || path === '/store/realdebrid' || path.startsWith('/store/realdebrid/');

const HOST = 'debridarr.local';
const OPAQUE = /^(?:debridarr:|https:\/\/debridarr\.local\/d\/)([a-f0-9]{40})[:/](0|[1-9][0-9]{0,8})$/i;
const FILE_BODY = 256 * 1024;
const PREMIUM_SECONDS = 365 * 24 * 3600;
const ACTIVE_LIMIT = 1000;
const scopeVerb: Record<TokenScope, string> = { read: 'read from', write: 'modify', link: 'create links for' };

function requireScope(token: StoreToken, scope: TokenScope): void {
  if (!token.scopes.includes(scope)) throw new RdError(403, 9, `This token cannot ${scopeVerb[scope]} the store.`);
}

function noContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function hash(value: string): string {
  const id = parseHex40(value);
  if (!id) throw new RdError(404, 7, 'resource_not_found');
  return id;
}

function integer(value: string | null, fallback: number, maximum: number, minimum = 0): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new RdError(400, 2, 'bad_parameter_value');
  return Number(value);
}

function methodOf(request: IncomingMessage): string {
  const verb = request.headers['x-http-verb'];
  if (typeof verb === 'string') {
    const method = verb.toUpperCase();
    if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'DELETE') return method;
  }
  return request.method ?? 'GET';
}

function routeOf(pathname: string): { route: string; prefix: string } {
  if (pathname.startsWith('/store/realdebrid/rest/1.0')) {
    return { route: pathname.slice('/store/realdebrid/rest/1.0'.length) || '/', prefix: '/store/realdebrid/rest/1.0' };
  }
  if (pathname.startsWith('/store/realdebrid')) {
    return { route: pathname.slice('/store/realdebrid'.length) || '/', prefix: '/store/realdebrid' };
  }
  return { route: pathname.slice('/rest/1.0'.length) || '/', prefix: '/rest/1.0' };
}

async function fields(request: IncomingMessage): Promise<Record<string, string>> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim();
  if (type === 'application/json') {
    const input = objectRecord(await body(request, FILE_BODY));
    if (!input) throw new RdError(400, 2, 'bad_parameter_value');
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' || typeof value === 'number') out[key] = String(value);
    }
    return out;
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const raw = await bytes(request, FILE_BODY);
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  throw new RdError(400, 2, 'bad_parameter_value');
}

function rdStatus(item: Transfer, status: TransferStatus | undefined): string {
  if (item.lifecycle === 'registering') return 'magnet_conversion';
  switch (status?.state) {
    case 'queued': return 'queued';
    case 'downloading': return 'downloading';
    case 'ready': return 'downloaded';
    case 'error': return 'error';
    case 'missing': return 'dead';
    default: return 'magnet_conversion';
  }
}

function fileLink(id: string, fileId: string): string {
  return `https://${HOST}/d/${id}/${fileId}`;
}

function filePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function mimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ({ mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

function summary(item: Transfer, status: TransferStatus | undefined, files: TransferFile[]) {
  const selected = files.filter(f => f.selected);
  const state = rdStatus(item, status);
  const progress = Math.min(100, Math.max(0, Math.round((status?.progress ?? 0) * 100)));
  const links = state === 'downloaded' ? selected.filter(f => f.video).map(f => fileLink(item.id, f.id)) : [];
  return {
    id: item.id,
    filename: item.name,
    hash: item.id,
    bytes: selected.reduce((n, f) => n + f.bytes, 0) || item.bytes,
    host: HOST,
    split: 0,
    progress,
    status: state,
    added: new Date(item.addedAt).toISOString(),
    links,
  };
}

async function listedFiles(service: TransferService, id: string): Promise<TransferFile[]> {
  try { return await service.files(id); }
  catch (error) {
    if (error instanceof TransferError && (error.code === 'unavailable' || error.code === 'not_found')) return service.selectedFiles(id);
    throw error;
  }
}

function requireItem(service: TransferService, id: string): Transfer {
  const item = service.get(id);
  if (!item) throw new RdError(404, 7, 'resource_not_found');
  return item;
}

export function rdErrorCode(error: unknown, status: number): number {
  if (error instanceof RdError) return error.errorCode;
  if (status === 401) return 8;
  if (status === 403) return 9;
  if (status === 404) return 7;
  if (status === 405) return 4;
  if (status === 409) return 33;
  if (status === 413) return 26;
  if (status === 429) return 34;
  if (status === 400 || status === 415 || status === 422) return status === 422 ? 30 : 2;
  if (status >= 500) return 25;
  return -1;
}

export function rdErrorStatus(status: number): number {
  return status === 422 || status === 415 ? 400 : status;
}

export async function realdebridRoutes(
  request: IncomingMessage, response: ServerResponse, url: URL, service: TransferService, token: StoreToken,
): Promise<void> {
  const method = methodOf(request);
  const { route, prefix } = routeOf(url.pathname);

  if (route === '/user' && method === 'GET') {
    requireScope(token, 'read');
    const expiration = new Date(Date.now() + PREMIUM_SECONDS * 1000).toISOString();
    json(response, 200, {
      id: Number.parseInt(token.id.slice(0, 8), 16),
      username: token.name,
      email: '',
      points: 0,
      locale: 'en',
      avatar: '',
      type: 'premium',
      premium: PREMIUM_SECONDS,
      expiration,
    });
    return;
  }

  if (route === '/torrents/instantAvailability' || route.startsWith('/torrents/instantAvailability/')) {
    if (method !== 'GET') throw new RdError(405, 4, 'method_not_allowed');
    throw new RdError(501, 37, 'disabled_endpoint');
  }

  if (route === '/torrents/availableHosts' && method === 'GET') {
    requireScope(token, 'read');
    json(response, 200, [{ host: HOST, max_file_size: 2147483647 }]);
    return;
  }

  if (route === '/torrents/activeCount' && method === 'GET') {
    requireScope(token, 'read');
    const all = service.list();
    const statuses = all.length ? await service.status(all.map(i => i.id)) : {};
    const nb = all.filter(item => {
      const state = rdStatus(item, statuses[item.id]);
      return state !== 'downloaded' && state !== 'error' && state !== 'dead';
    }).length;
    json(response, 200, { nb, limit: ACTIVE_LIMIT });
    return;
  }

  if (route === '/torrents' && method === 'GET') {
    requireScope(token, 'read');
    const all = service.list();
    const statuses = all.length ? await service.status(all.map(i => i.id)) : {};
    const filter = url.searchParams.get('filter');
    if (filter !== null && filter !== 'active') throw new RdError(400, 2, 'bad_parameter_value');
    const matched = filter === 'active'
      ? all.filter(item => {
        const state = rdStatus(item, statuses[item.id]);
        return state !== 'downloaded' && state !== 'error' && state !== 'dead';
      })
      : all;
    const limit = integer(url.searchParams.get('limit'), 100, 5000);
    const page = url.searchParams.get('page');
    const offset = page !== null
      ? (integer(page, 1, Number.MAX_SAFE_INTEGER, 1) - 1) * limit
      : integer(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    const pageItems = matched.slice(offset, offset + limit);
    json(response, 200, pageItems.map(item => summary(item, statuses[item.id], service.selectedFiles(item.id))), {
      'X-Total-Count': String(matched.length),
    });
    return;
  }

  if (route === '/torrents/addMagnet' && method === 'POST') {
    requireScope(token, 'write');
    const input = await fields(request);
    const magnet = input.magnet?.trim() ?? '';
    if (!magnet) throw new RdError(400, 1, 'missing_parameter');
    const infoHash = parseHex40(magnet);
    let source: { magnet: string } | { infoHash: string };
    if (infoHash) source = { infoHash };
    else {
      try { source = { magnet: validateMagnet(magnet) }; }
      catch { throw new RdError(400, 2, 'bad_parameter_value'); }
    }
    const { item } = await service.add({ source });
    json(response, 201, { id: item.id, uri: `${prefix}/torrents/info/${item.id}` });
    return;
  }

  if (route === '/torrents/addTorrent' && method === 'PUT') {
    requireScope(token, 'write');
    const torrent = await bytes(request, MAX_TORRENT);
    if (!torrent.length || !parseInfoHash(torrent)) throw new RdError(400, 30, 'torrent_file_invalid');
    const { item } = await service.add({ source: { torrent } });
    json(response, 201, { id: item.id, uri: `${prefix}/torrents/info/${item.id}` });
    return;
  }

  const info = /^\/torrents\/info\/([^/]+)$/.exec(route);
  if (info && method === 'GET') {
    requireScope(token, 'read');
    const id = hash(info[1]!);
    const item = requireItem(service, id);
    const statuses = await service.status([id]);
    const files = await listedFiles(service, id);
    json(response, 200, {
      ...summary(item, statuses[id], files),
      original_filename: item.name,
      original_bytes: files.reduce((n, f) => n + f.bytes, 0) || item.bytes,
      files: files.map(file => ({
        id: Number(file.id) + 1,
        path: filePath(file.path),
        bytes: file.bytes,
        selected: file.selected ? 1 : 0,
      })),
    });
    return;
  }

  const select = /^\/torrents\/selectFiles\/([^/]+)$/.exec(route);
  if (select && method === 'POST') {
    requireScope(token, 'write');
    const id = hash(select[1]!);
    let item = requireItem(service, id);
    const input = await fields(request);
    if (input.files === undefined) throw new RdError(400, 1, 'missing_parameter');
    // TransferService.select requires a managed record. Retrying add is the
    // public way to finish registration once the backend has metadata.
    if (item.lifecycle === 'registering') item = (await service.add({ source: { infoHash: id } })).item;
    if (item.lifecycle === 'registering') { noContent(response); return; }
    const files = await listedFiles(service, id);
    const wanted = fileIds(input.files, files);
    for (const fileId of wanted) {
      const file = files.find(f => f.id === fileId);
      if (!file?.video || file.bytes <= 0) throw new RdError(404, 7, 'resource_not_found');
      if (!file.selected) await service.select(id, fileId);
    }
    noContent(response);
    return;
  }

  const remove = /^\/torrents\/delete\/([^/]+)$/.exec(route);
  if (remove && method === 'DELETE') {
    requireScope(token, 'write');
    const id = hash(remove[1]!);
    requireItem(service, id);
    await service.remove(id);
    noContent(response);
    return;
  }

  if (route === '/unrestrict/link' && method === 'POST') {
    requireScope(token, 'link');
    const input = await fields(request);
    const link = input.link?.trim() ?? '';
    if (!link) throw new RdError(400, 1, 'missing_parameter');
    const match = OPAQUE.exec(link);
    if (!match) throw new RdError(503, 16, 'unsupported_hoster');
    const id = match[1]!.toLowerCase();
    const fileId = match[2]!;
    requireItem(service, id);
    const issued = await service.link(id, fileId);
    const filename = issued.file.path.split('/').at(-1) || issued.file.path;
    json(response, 200, {
      id: `${id}:${fileId}`,
      filename,
      mimeType: mimeType(filename),
      filesize: issued.file.bytes,
      link,
      host: HOST,
      chunks: 1,
      crc: 0,
      download: issued.url,
      streamable: issued.file.video ? 1 : 0,
    });
    return;
  }

  if (
    route === '/user' || route === '/torrents' || route === '/torrents/addMagnet' || route === '/torrents/addTorrent'
    || route === '/torrents/availableHosts' || route === '/torrents/activeCount' || route === '/unrestrict/link'
    || /^\/torrents\/(?:info|selectFiles|delete)\/[^/]+$/.test(route)
  ) throw new RdError(405, 4, 'method_not_allowed');
  throw new RdError(404, 3, 'unknown_method');
}

function fileIds(raw: string, files: TransferFile[]): string[] {
  const value = raw.trim();
  if (!value) throw new RdError(400, 2, 'bad_parameter_value');
  if (value === 'all') return files.filter(f => f.video && f.bytes > 0).map(f => f.id);
  const parts = value.split(',').map(part => part.trim());
  if (!parts.length || parts.some(part => !/^[1-9][0-9]{0,8}$/.test(part))) throw new RdError(400, 2, 'bad_parameter_value');
  return parts.map(part => {
    const id = String(Number(part) - 1);
    if (!files.some(file => file.id === id)) throw new RdError(404, 7, 'resource_not_found');
    return id;
  });
}
