import { BlockList, isIP, isIPv4 } from 'node:net';
import type { IncomingMessage } from 'node:http';

// Who is "the client"?
//
// Login throttling, store-token rate limits and admission slots all key on a
// client identity. Taken straight from the socket, that identity is the
// reverse proxy for every request behind one: five failed logins from anyone
// lock out the administrator, and every caller shares a single set of slots.
//
// X-Forwarded-For cannot simply be trusted instead, because a direct caller
// can forge it and mint a fresh identity per request, which defeats the same
// limits from the other direction. So the header is honoured only when the
// peer that delivered it is a configured proxy, and the identity is the
// right-most address that is not itself trusted -- the last hop the trusted
// chain actually observed, and the earliest one an attacker cannot fake.
//
// Default is no trusted proxies, i.e. the previous socket-only behaviour.

export class TrustedProxyError extends Error {}

// Shorthands for the common deployments: a sidecar proxy on loopback, or one
// on a Docker bridge network whose address is assigned at runtime.
const GROUPS: Record<string, readonly [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']],
  private: [
    ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
    ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'],
    ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
  ],
};

export interface TrustedProxies {
  readonly configured: boolean;
  trusts(address: string): boolean;
}

// IPv4-mapped IPv6 (::ffff:10.0.0.5) is what a dual-stack listener reports for
// an IPv4 peer. Compare it as the IPv4 address it actually is.
function normalize(address: string): string {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

export function parseTrustedProxies(raw: string | undefined): TrustedProxies {
  const entries = (raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) return { configured: false, trusts: () => false };

  const list = new BlockList();
  for (const entry of entries) {
    const group = GROUPS[entry.toLowerCase()];
    if (group) {
      for (const [address, prefix, type] of group) list.addSubnet(address, prefix, type);
      continue;
    }
    const slash = entry.indexOf('/');
    if (slash === -1) {
      const address = normalize(entry);
      if (!isIP(address)) throw new TrustedProxyError(`TRUSTED_PROXIES entry ${JSON.stringify(entry)} is not an IP address, CIDR range, or one of: ${Object.keys(GROUPS).join(', ')}`);
      list.addAddress(address, isIPv4(address) ? 'ipv4' : 'ipv6');
      continue;
    }
    const address = normalize(entry.slice(0, slash));
    const prefix = Number(entry.slice(slash + 1));
    const type = isIPv4(address) ? 'ipv4' : 'ipv6';
    const max = type === 'ipv4' ? 32 : 128;
    if (!isIP(address) || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new TrustedProxyError(`TRUSTED_PROXIES entry ${JSON.stringify(entry)} is not a valid CIDR range`);
    }
    list.addSubnet(address, prefix, type);
  }

  return {
    configured: true,
    trusts: address => {
      const candidate = normalize(address);
      if (!isIP(candidate)) return false;
      return list.check(candidate, isIPv4(candidate) ? 'ipv4' : 'ipv6');
    },
  };
}

let trusted: TrustedProxies = { configured: false, trusts: () => false };

export function setTrustedProxies(proxies: TrustedProxies): void {
  trusted = proxies;
}

export function clientAddress(request: IncomingMessage, proxies: TrustedProxies = trusted): string {
  const socket = request.socket.remoteAddress;
  if (!socket) return 'unknown';
  if (!proxies.configured || !proxies.trusts(socket)) return normalize(socket);

  const header = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',').map(normalize).filter(entry => isIP(entry));
  if (forwarded.length === 0) return normalize(socket);

  // Right-most untrusted entry: everything to its right is a hop we trust, so
  // this is the furthest-left address that a client could not have forged.
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    if (!proxies.trusts(forwarded[index]!)) return forwarded[index]!;
  }
  return forwarded[0]!;
}
