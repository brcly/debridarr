import { randomBytes, createHash } from 'node:crypto';
import type { PrepareTransferRequest } from '../application/types.js';

export const MAX_REFERENCES = 1000;
export const MAX_REFERENCE_BYTES = 16384;
export const TTL = 24 * 60 * 60 * 1000;
export const identifier = () => randomBytes(32).toString('base64url');
export interface Reference { id: string; created: number; source: string; request: PrepareTransferRequest }
export interface Document { version: 3; key: string; references: Reference[] }
export function sourceIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export { JsonAddonAccess as AddonAccess } from '../state/json/addon.js';
