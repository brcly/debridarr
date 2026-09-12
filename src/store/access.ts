import { createHash } from 'node:crypto';
import { BusyError } from '../security/admission.js';
import { CONTROL_CHARACTERS } from '../security/text.js';
import { objectRecord } from '../json.js';

export class StoreAuthThrottle extends BusyError { readonly retryAfter = 900; }

// A token carries the least access a client needs: `read` inspects transfers,
// `write` creates/selects/deletes, `link` mints playback links. Legacy tokens
// (schema 1) are migrated to all three so existing clients keep working.
export const tokenScopes = ['read', 'write', 'link'] as const;
export type TokenScope = typeof tokenScopes[number];
export const defaultTokenScopes: TokenScope[] = [...tokenScopes];

export interface TokenQuotas { requestsPerMinute: number; concurrentRequests: number }
export interface StoreToken { id: string; name: string; createdAt: number; lastUsedAt: number | null; quotas: TokenQuotas; scopes: TokenScope[] }
export interface SavedToken extends StoreToken { digest: string }
export interface Document { version: 2; tokens: SavedToken[]; linkSecret: string }
export const digest = (token: string) => createHash('sha256').update(token).digest();
export const MAX_TOKENS = 100;
export const defaultTokenQuotas: TokenQuotas = { requestsPerMinute: 120, concurrentRequests: 4 };

export function tokenOptions(input: unknown): { name: string; quotas: TokenQuotas; scopes: TokenScope[] } {
  const b = objectRecord(input);
  if (!b) throw new Error('Provide a token name and optional quotas.');
  if (Object.keys(b).some(k => k !== 'name' && k !== 'quotas' && k !== 'scopes') || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100 || CONTROL_CHARACTERS.test(b.name)) throw new Error('Token name must contain 1–100 characters without control characters.');
  const quotas = { ...defaultTokenQuotas };
  if (b.quotas !== undefined) {
    const quotaFields = objectRecord(b.quotas);
    if (!quotaFields) throw new Error('Invalid token quotas.');
    for (const [key, value] of Object.entries(quotaFields)) {
      if (key !== 'requestsPerMinute' && key !== 'concurrentRequests') throw new Error('Quota must be a whole number: requestsPerMinute 1–6000, concurrentRequests 1–32.');
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > (key === 'requestsPerMinute' ? 6000 : 32)) {
        throw new Error('Quota must be a whole number: requestsPerMinute 1–6000, concurrentRequests 1–32.');
      }
      quotas[key] = value;
    }
  }
  let scopes: TokenScope[] = [...defaultTokenScopes];
  if (b.scopes !== undefined) {
    if (!Array.isArray(b.scopes) || !b.scopes.length || b.scopes.length > tokenScopes.length
      || b.scopes.some(scope => typeof scope !== 'string' || !tokenScopes.includes(scope as TokenScope))
      || new Set(b.scopes).size !== b.scopes.length) {
      throw new Error(`Token scopes must be a non-empty set drawn from: ${tokenScopes.join(', ')}.`);
    }
    scopes = tokenScopes.filter(scope => (b.scopes as string[]).includes(scope));
  }
  return { name: b.name.trim(), quotas, scopes };
}

export { JsonStoreAccess as StoreAccess } from '../state/json/access.js';
