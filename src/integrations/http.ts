export type ConnectionCode = 'connected' | 'not_configured' | 'authentication' | 'unreachable' | 'timeout' | 'unexpected_response';
export interface ConnectionResult { ok: boolean; code: ConnectionCode; message: string; version?: string }
export class ConnectionError extends Error {
  // HTTP status that produced this error, when there was a response (0 for an
  // opaque redirect). Diagnostic only; never surfaced to API clients.
  status?: number;
  constructor(public readonly code: ConnectionCode) { super(code); }
}

export async function serviceFetch(url: string, signal: AbortSignal, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...options, signal, redirect: 'manual' });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new ConnectionError([401, 403].includes(response.status) ? 'authentication' : 'unexpected_response');
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function smallBytes(response: Response, maxBytes = 64 * 1024): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new ConnectionError('unexpected_response'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}

export async function smallText(response: Response, maxBytes = 64 * 1024): Promise<string> {
  return (await smallBytes(response, maxBytes)).toString('utf8');
}

export async function checkConnection(check: (signal: AbortSignal) => Promise<string>, timeoutMs = 10_000): Promise<ConnectionResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const version = await check(signal);
    return { ok: true, code: 'connected', message: 'Connected successfully.', version };
  } catch (error) {
    const code = signal.aborted ? 'timeout' : error instanceof ConnectionError ? error.code : 'unreachable';
    const messages: Record<ConnectionCode, string> = {
      connected: 'Connected successfully.', not_configured: 'Enter the service URL and credentials before testing.',
      authentication: 'Authentication failed or access was denied. Check credentials and service access rules.',
      unreachable: 'Cannot reach the service. Check its address, network, and TLS certificate.',
      timeout: 'The connection test timed out.',
      unexpected_response: 'The service returned an unexpected response. Check its base URL and proxy configuration.',
    };
    return { ok: false, code, message: messages[code] };
  }
}
export function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^v?\d+\.\d+[\w.+-]*$/.test(value) && value.length < 80;
}
