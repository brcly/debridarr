import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveFile } from './serve.js';

const CLIP = 'downloading.mp4';

// A short "still downloading" clip Stremio can actually play. Serving this the
// moment a fresh torrent has nothing on disk beats leaving the player on a
// black screen until a buffering timeout. The file ships next to the web assets
// (dist/web); fall back to the source tree when running from tsx.
export async function servePlaceholder(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const bundled = fileURLToPath(new URL(`../web/${CLIP}`, import.meta.url));
  const file = await open(bundled).catch(() => open(resolve('web', CLIP)));
  try {
    await serveFile(request, response, file, CLIP, { size: (await file.stat()).size, signal });
  } finally {
    await file.close();
  }
}
