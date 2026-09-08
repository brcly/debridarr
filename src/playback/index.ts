import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PlayTarget } from '../addon/play.js';
import type { Config } from '../config.js';
import { DAY_MS, DownloadError, ensureDownload, type DownloadState } from '../downloads/manager.js';
import type { DownloadsStore } from '../downloads/store.js';
import type { QBittorrentClient } from '../integrations/qbittorrent/client.js';
import type { Settings } from '../settings.js';
import { markActive, markInactive } from './active.js';
import { openConfinedFile, resolveLocalFile } from './paths.js';
import { serveFile } from './serve.js';

const PREPARE_DEADLINE_MS = 30_000;
const READY_WAIT_MS = 4_000;
const READY_POLL_MS = 1_000;
const NOT_MOUNTED = 'The downloaded file is not visible to Debridarr. Check the download volume mount.';

export interface PlayContext {
  config: Config;
  qbt: QBittorrentClient;
  store: DownloadsStore;
  retention: Settings['retention'];
  prowlarr?: Settings['prowlarr'];
  // How long to wait for a nearly-complete file before answering "downloading".
  readyWaitMs?: number;
  prepared?: () => void;
}

function json(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(body));
}

export async function handlePlay(request: IncomingMessage, response: ServerResponse, target: PlayTarget, ctx: PlayContext): Promise<void> {
  if (!ctx.qbt.configured) { json(response, 503, { error: 'qBittorrent is not configured. Set it in /configure.', code: 'qbittorrent_unconfigured' }); return; }

  const signal = AbortSignal.timeout(PREPARE_DEADLINE_MS);
  let state: DownloadState;
  try {
    state = await ensureDownload(target, {
      qbt: ctx.qbt, store: ctx.store, signal,
      ...(ctx.prowlarr ? { prowlarr: ctx.prowlarr } : {}),
      retentionDays: ctx.retention.days, ratioLimit: ctx.retention.targetRatio,
      onReady: value => markActive(value.record.infoHash),
    });
  } catch (error) {
    if (error instanceof DownloadError) {
      const status = error.code === 'no_metadata' ? 503
        : error.code === 'no_infohash' || error.code === 'no_file' ? 422 : 502;
      json(response, status, { error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  ctx.prepared?.();
  try {
    // Cached torrents are ready immediately; give a nearly-done one a short grace.
    let file = state.file;
    const deadline = Date.now() + (ctx.readyWaitMs ?? READY_WAIT_MS);
    while (file.progress < 1 && Date.now() < deadline && !signal.aborted) {
      await sleep(READY_POLL_MS);
      const files = await ctx.qbt.files(state.record.infoHash, signal).catch(() => []);
      file = files.find(entry => entry.index === state.file.index) ?? file;
    }
    if (file.progress < 1) {
      json(response, 503, {
        status: 'downloading',
        progress: Number(file.progress.toFixed(4)),
        name: state.record.name,
        code: 'downloading',
      }, { 'Retry-After': '15' });
      return;
    }

    const local = resolveLocalFile(state.torrent.savePath, file.name, ctx.config.downloadDir);
    if (!local) { json(response, 502, { error: NOT_MOUNTED, code: 'not_mounted' }); return; }

    // A completed watch renews the lease, so anything still being (re)watched
    // stays cached; a failure to persist this is not fatal to playback.
    if (ctx.retention.extendOnPlay) {
      await ctx.store.renew(state.record.infoHash, Date.now() + ctx.retention.days * DAY_MS).catch(() => {});
    }

    try {
      const opened = await openConfinedFile(local, ctx.config.downloadDir);
      try { await serveFile(request, response, opened, file.name); }
      finally { await opened.close(); }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        json(response, 502, { error: NOT_MOUNTED, code: 'not_mounted' });
        return;
      }
      throw error;
    }
  } finally {
    markInactive(state.record.infoHash);
  }
}
