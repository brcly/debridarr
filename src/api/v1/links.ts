import { createHmac, timingSafeEqual } from 'node:crypto';
import { objectRecord } from '../../json.js';
import { isHex40 } from '../../domain/ids.js';
import type { TransferLinkIssuer, TransferLinkRequest } from '../../application/types.js';

// A `/api/v1` file link is a stateless, HMAC-signed capability. The signature
// key (`StoreAccess.linkSecret()`) is per-deployment and persisted, so links
// survive a restart without any link table. Rotating the secret invalidates
// every outstanding link.

export const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PATH = 1024;

export interface LinkClaim {
  infoHash: string;
  fileId: number;
  path: string;
  bytes: number;
  marker: string;
  exp: number;
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const sign = (secret: Buffer, payload: string) => createHmac('sha256', secret).update(payload).digest();

export function signLink(secret: Buffer, claim: LinkClaim): string {
  const payload = b64url(JSON.stringify({ v: 1, ...claim }));
  return `${payload}.${b64url(sign(secret, payload))}`;
}

export function verifyLink(secret: Buffer, token: string, now: number): LinkClaim | undefined {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return undefined;
  const payload = token.slice(0, dot);
  let provided: Buffer;
  try { provided = Buffer.from(token.slice(dot + 1), 'base64url'); }
  catch { return undefined; }
  const expected = sign(secret, payload);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  let raw: Record<string, unknown> | undefined;
  try { raw = objectRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); }
  catch { return undefined; }
  if (!raw) return undefined;
  if (raw.v !== 1
    || typeof raw.infoHash !== 'string' || !isHex40(raw.infoHash)
    || !Number.isInteger(raw.fileId) || (raw.fileId as number) < 0
    || typeof raw.path !== 'string' || !raw.path || raw.path.length > MAX_PATH
    || !Number.isInteger(raw.bytes) || (raw.bytes as number) < 0
    || typeof raw.marker !== 'string' || !raw.marker
    || !Number.isFinite(raw.exp) || (raw.exp as number) <= now) return undefined;
  return { infoHash: raw.infoHash, fileId: raw.fileId as number, path: raw.path, bytes: raw.bytes as number, marker: raw.marker, exp: raw.exp as number };
}

// Turns the application service's link requests into absolute
// `${apiBase}/download/<signed>` URLs. `apiBase` already includes `/api/v1`.
export function nativeLinkIssuer(apiBase: string, secret: Buffer, now: () => number = Date.now): TransferLinkIssuer {
  return {
    issue: (requests: TransferLinkRequest[]) => Promise.resolve(requests.map(request => {
      const token = signLink(secret, {
        infoHash: request.transferId, fileId: request.file.id, path: request.file.path,
        bytes: request.file.bytes, marker: request.file.marker, exp: now() + LINK_TTL_MS,
      });
      return `${apiBase}/download/${token}`;
    })),
  };
}
