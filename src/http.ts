import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(body));
}

export async function body(request: IncomingMessage, maxBytes = 32 * 1024): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new HttpError(415, 'Use application/json');
  }
  const raw = await bytes(request, maxBytes);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

export async function bytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  // Do not destroy the request on rejection: the caller still needs the JSON error.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) { request.resume(); throw new HttpError(413, 'Request is too large'); }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
