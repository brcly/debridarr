import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
  if (start > end || start >= size) return null;
  return { start, end };
}

// Serve a fully-downloaded file with HTTP range support. Assumes the file is
// complete; partial-file streaming is a later milestone.
export async function serveFile(request: IncomingMessage, response: ServerResponse, file: FileHandle, fileName: string): Promise<void> {
  const { size } = await file.stat();
  const headers: Record<string, string> = {
    'Content-Type': contentType(fileName),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
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
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD' || size === 0) { response.end(); return; }

  const stream = file.createReadStream({ start, end, autoClose: false });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  await new Promise<void>(done => {
    stream.on('close', done);
    response.on('close', done);
  });
}
