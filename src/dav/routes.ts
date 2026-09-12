import { clientAddress } from '../security/clientAddress.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bytes, HttpError } from '../http.js';
import type { StoreAccessRepository } from '../state/repositories.js';
import type { TokenScope } from '../store/access.js';
import { TransferError, type TransferService } from '../application/transfers.js';
import type { TransferFile } from '../application/types.js';
import type { DownloadBackend } from '../backends/download.js';
import { openTorrentFile } from '../playback/paths.js';
import { contentType, serveFile } from '../playback/serve.js';
import { resolveWithin, transferSlugs, type DavResource, type DavTransferSlug } from './tree.js';
import { multistatus, type DavEntry } from './xml.js';
import { DAV_TIMEOUT_MS } from '../timeouts.js';

export const isDavPath = (pathname: string): boolean => pathname === '/dav' || pathname.startsWith('/dav/');

export interface DavServiceView {
  service: TransferService;
  backend: DownloadBackend;
  downloadDir: string;
}

export interface DavDeps {
  storeAccess: StoreAccessRepository;
  // False in `search` mode: nothing is store-owned for a DAV client to read.
  enabled: boolean;
  service: () => Promise<DavServiceView>;
}

const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD';
// A dedicated dav scope would work too (the roadmap offers either); read +
// link avoids a new scope value and a migration for existing tokens — most
// already hold it, since new tokens default to all three.
const REQUIRED_SCOPES: TokenScope[] = ['read', 'link'];
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// WebDAV clients (Finder, Windows, cadaver, rclone) are native apps that
// expect HTTP Basic — the password carries the API token, username is
// ignored. Bearer is also accepted for a client that can set custom headers.
function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header)?.[1];
  if (bearer) return bearer;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header)?.[1];
  if (!basic) return undefined;
  let decoded: string;
  try { decoded = Buffer.from(basic, 'base64').toString('utf8'); } catch { return undefined; }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return TOKEN_SHAPE.test(password) ? password : undefined;
}

function segmentsFromPath(pathname: string): string[] {
  return pathname.slice('/dav'.length).split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
}

function mapTransferError(error: unknown): HttpError | undefined {
  return error instanceof TransferError
    ? new HttpError(error.code === 'not_found' ? 404 : error.code === 'bad_source' ? 400 : 503, error.message)
    : undefined;
}

// A collection may reject Depth: infinity (RFC 4918 §9.1); real clients walk
// one level at a time anyway, and this keeps a PROPFIND response bounded.
function depthOf(request: IncomingMessage): 0 | 1 {
  const header = request.headers.depth;
  if (header === '0') return 0;
  if (header === undefined || header === '1') return 1;
  throw new HttpError(403, 'This WebDAV mount only supports Depth: 0 or 1.');
}

// Selected, complete, playable — never an unselected extra or a
// still-downloading piece-gated file.
async function eligibleFiles(service: TransferService, infoHash: string): Promise<TransferFile[]> {
  const files = await service.files(infoHash);
  return files.filter(f => f.video && f.bytes > 0 && f.progress >= 1 && f.selected);
}

async function openFile(backend: DownloadBackend, downloadDir: string, infoHash: string, file: TransferFile, signal: AbortSignal) {
  const torrent = await backend.get(infoHash, signal);
  if (!torrent) throw new TransferError('unavailable', 'The transfer is not available in the download backend.');
  const rawFiles = await backend.getFiles(infoHash, signal);
  const rawFile = rawFiles.find(candidate => String(candidate.id) === file.id);
  if (!rawFile) throw new TransferError('unavailable', 'The file is no longer available in the download backend.');
  const handle = await openTorrentFile(torrent, rawFile, downloadDir, backend.pathMappings);
  return { handle, size: rawFile.bytes };
}

function toEntry(segments: string[], displayName: string, shape: { collection: true } | { collection: false; file: TransferFile }): DavEntry {
  return shape.collection
    ? { segments, collection: true, displayName }
    : { segments, collection: false, displayName, bytes: shape.file.bytes, contentType: contentType(shape.file.path) };
}

function sendMultistatus(response: ServerResponse, entries: DavEntry[]): void {
  const body = multistatus(entries);
  response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) });
  response.end(body);
}

function managedTransferSlugs(service: TransferService): DavTransferSlug[] {
  return transferSlugs(service.list().filter(t => t.lifecycle === 'managed'));
}

function propfindRoot(request: IncomingMessage, response: ServerResponse, service: TransferService): void {
  const depth = depthOf(request);
  const entries: DavEntry[] = [{ segments: [], collection: true, displayName: 'Debridarr library' }];
  if (depth === 1) {
    for (const transfer of managedTransferSlugs(service)) entries.push({ segments: [transfer.slug], collection: true, displayName: transfer.name });
  }
  sendMultistatus(response, entries);
}

function propfindResource(request: IncomingMessage, response: ServerResponse, transfer: DavTransferSlug, rest: string[], resource: DavResource): void {
  const depth = depthOf(request);
  const selfName = rest.length ? rest[rest.length - 1]! : transfer.name;
  const self = resource.kind === 'collection' ? { collection: true as const } : { collection: false as const, file: resource.file };
  const entries: DavEntry[] = [toEntry([transfer.slug, ...rest], selfName, self)];
  if (depth === 1 && resource.kind === 'collection') {
    for (const child of resource.children) {
      const shape = child.collection ? { collection: true as const } : { collection: false as const, file: child.file! };
      entries.push(toEntry([transfer.slug, ...rest, child.name], child.name, shape));
    }
  }
  sendMultistatus(response, entries);
}

export async function davRoutes(request: IncomingMessage, response: ServerResponse, url: URL, deps: DavDeps): Promise<void> {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') { response.writeHead(204, { DAV: '1', Allow: ALLOW }); response.end(); return; }
  // PROPFIND commonly carries a small XML body specifying which properties
  // it wants; this always answers with the same fixed, broadly-useful set
  // instead, so the body is drained (never parsed) here — unconditionally,
  // so an unread body can never desynchronize a kept-alive connection.
  await bytes(request, 64 * 1024).catch(() => undefined);

  if (!deps.enabled) throw new HttpError(404, 'Not found');
  const candidate = extractToken(request.headers.authorization);
  const token = await deps.storeAccess.authenticate(candidate ?? '', clientAddress(request));
  if (!token) { response.setHeader('WWW-Authenticate', 'Basic realm="Debridarr"'); throw new HttpError(401, 'A valid API token is required.'); }
  if (!REQUIRED_SCOPES.every(scope => token.scopes.includes(scope))) throw new HttpError(403, 'This token needs the read and link scopes for WebDAV.');
  const release = deps.storeAccess.enter(token);
  try {
    if (method !== 'PROPFIND' && method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', ALLOW);
      throw new HttpError(405, 'This WebDAV mount is read-only.');
    }
    const segments = segmentsFromPath(url.pathname);
    const { service, backend, downloadDir } = await deps.service();

    if (segments.length === 0) {
      if (method !== 'PROPFIND') { response.setHeader('Allow', ALLOW); throw new HttpError(405, 'The root is a folder; use PROPFIND to list it.'); }
      propfindRoot(request, response, service);
      return;
    }

    const [transferSlug, ...rest] = segments;
    const transfer = managedTransferSlugs(service).find(candidateTransfer => candidateTransfer.slug === transferSlug);
    if (!transfer) throw new HttpError(404, 'No such transfer.');

    let files: TransferFile[];
    try { files = await eligibleFiles(service, transfer.id); }
    catch (error) { throw mapTransferError(error) ?? error; }

    const resource = resolveWithin(files, rest);
    if (!resource) throw new HttpError(404, 'No such file or folder.');

    if (method === 'PROPFIND') { propfindResource(request, response, transfer, rest, resource); return; }

    if (resource.kind === 'collection') { response.setHeader('Allow', ALLOW); throw new HttpError(405, 'That path is a folder; use PROPFIND to list it.'); }
    const signal = AbortSignal.timeout(DAV_TIMEOUT_MS);
    let opened: Awaited<ReturnType<typeof openFile>>;
    try { opened = await openFile(backend, downloadDir, transfer.id, resource.file, signal); }
    catch (error) { throw mapTransferError(error) ?? error; }
    try { await serveFile(request, response, opened.handle, resource.file.path, { size: opened.size, signal }); }
    finally { await opened.handle.close(); }
  } finally { release(); }
}
