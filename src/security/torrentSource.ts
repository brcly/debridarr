import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Settings } from '../settings.js';
import { magnetInfoHash } from '../downloads/magnet.js';

const blocked = new BlockList();
for (const [ip, prefix] of [ ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24],
  ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3] ] as const) blocked.addSubnet(ip, prefix);
for (const [ip, prefix] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]] as const) blocked.addSubnet(ip, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only global unicast IPv6; excludes mapped IPv4, local, multicast, and zones.
  if (family === 6 && !address.includes('%') && /^[23][0-9a-f]{3}:/i.test(address)) return !blocked.check(address, 'ipv6');
  return false;
}
export function validateProxy(raw: string, settings: Settings['prowlarr']): URL {
  const url = new URL(raw);
  const base = new URL(settings.url);
  const prefix = base.pathname.replace(/\/$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password
    || url.hash || !url.pathname.startsWith(prefix + '/') || !/^\/\d+\/download$/.test(url.pathname.slice(prefix.length))
    || !url.searchParams.get('link')) throw new Error('Invalid torrent proxy');
  // Never reuse a key embedded in an old search result.
  url.searchParams.delete('apikey');
  return url;
}
export function validateMagnet(raw: string): string {
  const url = new URL(raw);
  const hash = magnetInfoHash(raw);
  if (url.protocol !== 'magnet:' || !hash || url.username || url.password || url.host
    || url.searchParams.getAll('xt').some(xt => xt.startsWith('urn:btih:') && magnetInfoHash(`magnet:?xt=${encodeURIComponent(xt)}`) !== hash)) throw new Error('Invalid magnet');
  return raw;
}
type ResolveHost = (host: string) => Promise<LookupAddress[]>;
export async function publicDestination(url: URL, resolveHost: ResolveHost = host => lookup(host, { all: true }), signal?: AbortSignal): Promise<LookupAddress> {
  signal?.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new Error('Torrent lookup aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    void resolveHost(host).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Unsafe redirect destination');
  return addresses[0]!;
}
// No second DNS lookup is allowed between validation and connection. Keeping
// the original URL also preserves the HTTP Host header and TLS server name.
export function pinnedLookup(destination: LookupAddress): LookupFunction {
  return (_hostname, _options, callback) => callback(null, destination.address, destination.family);
}
export type TorrentSource = { bytes: Buffer; magnet?: never } | { magnet: string; bytes?: never };
export async function fetchTorrentSource(raw: string, settings: Settings['prowlarr'], signal: AbortSignal): Promise<TorrentSource> {
  let url = validateProxy(raw, settings);
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    if (url.protocol === 'magnet:') return { magnet: validateMagnet(url.href) };
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe redirect');
    const pinned = hop === 0 ? undefined : await publicDestination(url, undefined, signal);
    signal.throwIfAborted();
    const result = await new Promise<{ location?: string; bytes?: Buffer }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        signal, agent: false,
        headers: { Accept: 'application/x-bittorrent', ...(hop === 0 ? { 'X-Api-Key': settings.apiKey } : {}) },
        ...(pinned ? { family: pinned.family, autoSelectFamily: false, lookup: pinnedLookup(pinned) } : {}),
      }, response => {
        const status = response.statusCode ?? 0;
        if ([301,302,303,307,308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) reject(new Error('Missing redirect')); else resolve({ location });
          return;
        }
        if (status !== 200) { response.destroy(); reject(new Error('Torrent request failed')); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 10 * 1024 * 1024) { response.destroy(new Error('Torrent too large')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Incomplete torrent response')));
      });
      req.on('error', reject);
      req.end();
    });
    if (result.bytes) return { bytes: result.bytes };
    url = new URL(result.location!, url);
  }
  throw new Error('Too many redirects');
}
