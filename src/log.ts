import { randomUUID } from 'node:crypto';

export const logLevels = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = typeof logLevels[number];

const rank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (rank[level] > rank[current]) return;
  if (level === 'debug') console.info(...args);
  else console[level](...args);
}

export const log = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
};

export function redactPath(pathname: string): string {
  return pathname
    .replace(/\/addon\/[^/]+/g, '/addon/[redacted]')
    .replace(/\/api\/v1\/download\/[^/]+/g, '/api/v1/download/[redacted]')
    .replace(/\/play\/[^/]+/g, '/play/[redacted]');
}

// Bounded, safe-charset so a client-supplied X-Request-Id cannot inject
// newlines/control characters into the log or grow the log line unbounded.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,100}$/;

export function requestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && REQUEST_ID.test(value) ? value : randomUUID();
}

export function logRequest(method: string | undefined, url: string | undefined, status: number, ms: number, id?: string): void {
  let pathname = '/';
  try { pathname = new URL(url ?? '/', 'http://localhost').pathname; }
  catch { pathname = url ?? '/'; }
  if (pathname === '/health' || pathname === '/health/ready') return;
  log.info(JSON.stringify({ method: method ?? 'GET', path: redactPath(pathname), status, ms, ...(id ? { requestId: id } : {}) }));
}
