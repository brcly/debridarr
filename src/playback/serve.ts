import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { BufferingError } from './pieces.js';
import { DEFAULT_BUFFER_WAIT_MS } from '../timeouts.js';

const TYPES: Record<string, string> = {
  mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
};

export function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

// Parse one `bytes=start-end` range. `undefined` = no Range header; `null` = a
// header we should answer with 416.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | null {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

// Content-Length describes the final file, even when the inode is still growing.
// A partial reader must gate every read on verified torrent pieces.
export async function serveFile(request: IncomingMessage, response: ServerResponse, file: FileHandle, fileName: string, options?: {
  size: number; signal: AbortSignal; beforeRead?: (start: number, end: number) => Promise<void>; waitMs?: number;
}): Promise<void> {
  const size = options?.size ?? (await file.stat()).size;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  const headers: Record<string, string> = {
    'Content-Type': contentType(fileName),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  };

  const range = parseRange(request.headers.range, size);
  if (range === null) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    response.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers['Content-Length'] = String(end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (request.method === 'HEAD' || size === 0) { response.writeHead(range ? 206 : 200, headers); response.end(); return; }
  const disconnected = new AbortController();
  const close = () => disconnected.abort();
  response.on('close', close);
  const signal = options ? AbortSignal.any([options.signal, disconnected.signal]) : disconnected.signal;
  try {
    // Complete files use the kernel copy path. Piece-gated reads stay on the
    // 64 KiB loop so a hole cannot be sent as a short HTTP body.
    if (!options?.beforeRead) {
      if (!response.headersSent) response.writeHead(range ? 206 : 200, headers);
      const readable = file.createReadStream({ start, end, autoClose: false });
      try { await pipeline(readable, response, { signal }); }
      catch (error) { readable.destroy(); throw error; }
      return;
    }
    // Once metadata and the confined file are available, let the player enter
    // buffering immediately instead of leaving it waiting for HTTP headers.
    response.writeHead(range ? 206 : 200, headers);
    response.flushHeaders();
    for (let position = start; position <= end;) {
      signal.throwIfAborted();
      const length = Math.min(64 * 1024, end - position + 1);
      await options.beforeRead(position, position + length - 1);
      // Even verified pieces can briefly precede disk visibility. Never send
      // an EOF/short read as a complete HTTP response.
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      const deadline = Date.now() + (options?.waitMs ?? DEFAULT_BUFFER_WAIT_MS);
      while (read < length) {
        signal.throwIfAborted();
        const result = await file.read(buffer, read, length - read, position + read);
        read += result.bytesRead;
        if (read < length) {
          if (!options?.beforeRead || Date.now() >= deadline) throw new BufferingError('The downloaded bytes are not visible on disk.');
          await sleep(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
        }
      }
      if (!response.headersSent) response.writeHead(range ? 206 : 200, headers);
      if (!response.write(buffer)) await once(response, 'drain', { signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_BUFFER_WAIT_MS)]) });
      position += length;
    }
    // Hold the active reservation until the last bytes have left the response.
    const finished = once(response, 'finish', { signal });
    response.end();
    await finished;
  } finally { response.off('close', close); }
}
