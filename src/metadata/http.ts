import { MetadataError } from './types.js';

// Bounded JSON read for third-party metadata APIs. Cinemeta series documents can
// carry every episode, so the cap is generous but still finite.
export async function fetchJson(url: string, signal: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
  } catch {
    throw new MetadataError('unavailable');
  }
  if (response.status === 404) { await response.body?.cancel(); throw new MetadataError('not_found'); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new MetadataError('not_configured'); }
  if (!response.ok) { await response.body?.cancel(); throw new MetadataError('unavailable'); }

  const reader = response.body?.getReader();
  if (!reader) throw new MetadataError('unavailable');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new MetadataError('unavailable'); }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new MetadataError('unavailable');
  }
}
