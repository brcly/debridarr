import { json } from '../http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { sourceInfoHash, type PrepareTransferRequest } from '../application/types.js';
import type { Config } from '../config.js';
import { DAY_MS, DownloadError, ensureTransfer, type DownloadState } from '../downloads/manager.js';
import type { DownloadsRepository } from '../state/repositories.js';
import type { DownloadBackend } from '../backends/download.js';
import type { Settings } from '../settings.js';
import { markActive, markInactive } from './active.js';
import { openTorrentFile } from './paths.js';
import { waitForPieceGate, BufferingError } from './pieces.js';
import type { FileHandle } from 'node:fs/promises';
import { serveFile } from './serve.js';
import { isOwned } from '../downloads/ownership.js';
import { servePlaceholder } from './placeholder.js';
import { log } from '../log.js';
import type { TransferSourceResolver } from '../application/types.js';
import { PREPARE_DEADLINE_MS, PROBE_TIMEOUT_MS } from '../timeouts.js';

const NOT_MOUNTED = 'The downloaded file is not visible to Debridarr. Check the download volume mount.';

export interface PlayContext {
  config: Config;
  backend: DownloadBackend;
  store: DownloadsRepository;
  retention: Settings['retention'];
  storeMaxActiveDownloads?: number;
  sourceResolver?: TransferSourceResolver;
  streamWhileDownloading?: boolean;
  // Maximum wait for a missing file or unavailable piece; injectable for tests.
  readyWaitMs?: number;
}

export async function handlePlay(request: IncomingMessage, response: ServerResponse, req: PrepareTransferRequest, ctx: PlayContext): Promise<void> {
  if (!ctx.backend.configured) { json(response, 503, { error: 'The download backend is not configured. Set it in /configure.', code: 'download_backend_unconfigured' }); return; }

  const disconnected = new AbortController();
  const startedAt = Date.now();
  const label = req.media ? `${req.media.type}/${req.media.imdbId}` : `file/${sourceInfoHash(req.source)?.slice(0, 8) ?? '?'}`;
  let phase = 'preparing';
  const close = () => {
    if (!response.writableFinished) log.info(`Debridarr playback ${label}: disconnected phase=${phase} elapsed=${Date.now() - startedAt}ms`);
    disconnected.abort();
  };
  response.on('close', close);
  const showPlaceholder = async () => {
    try { await servePlaceholder(request, response, disconnected.signal); }
    catch {
      if (!response.headersSent) {
        json(response, 503, { error: 'Still preparing this torrent. Open the stream again shortly.', code: 'downloading' }, { 'Retry-After': '15' });
      }
    }
  };
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(PREPARE_DEADLINE_MS)]);
  let state: DownloadState;
  try {
    state = await ensureTransfer(req, {
      backend: ctx.backend, store: ctx.store, signal,
      ...(ctx.sourceResolver ? { sourceResolver: ctx.sourceResolver } : {}),
      retentionDays: req.origin === 'store' ? ctx.retention.storeLeaseDays : ctx.retention.days, ratioLimit: ctx.retention.targetRatio,
      minFreeSpaceGB: ctx.retention.minFreeSpaceGB, storeMaxActiveDownloads: ctx.storeMaxActiveDownloads ?? 20,
      metadataTimeoutMs: ctx.readyWaitMs ?? ctx.config.metadataWaitMs,
      onReady: value => markActive(value.record.infoHash),
    });
  } catch (error) {
    response.off('close', close);
    if (disconnected.signal.aborted) return;
    if (error instanceof DownloadError) {
      if (error.code === 'no_metadata') {
        log.info(`Debridarr playback ${label}: metadata not ready, serving placeholder elapsed=${Date.now() - startedAt}ms`);
        await showPlaceholder();
        return;
      }
      log.warn(`Debridarr playback ${label}: ${error.code} elapsed=${Date.now() - startedAt}ms`);
      const status = error.code === 'low_space' ? 507 : error.code === 'space_unknown' ? 503 : error.code === 'cache_missing' ? 404
        : error.code === 'no_infohash' || error.code === 'no_file' ? 422 : 502;
      json(response, status, { error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  try {
    phase = 'opening_file';
    const file = state.file;
    if (file.progress < 1 && (!ctx.streamWhileDownloading || file.progress === 0 || !ctx.backend.capabilities.pieces)) {
      phase = 'placeholder';
      log.info(`Debridarr playback ${label}: download incomplete, serving placeholder progress=${Number(file.progress.toFixed(4))} elapsed=${Date.now() - startedAt}ms`);
      await showPlaceholder();
      return;
    }
    const waitMs = ctx.readyWaitMs ?? ctx.config.bufferWaitMs;
    const playSignal = disconnected.signal; // Preparation timeout must not cut off a long watch.
    let opened: FileHandle | undefined;
    try {
      let gate: ((start: number, end: number) => Promise<void>) | undefined;
      const beforeRead = file.progress < 1 ? async (start: number, end: number) => {
        phase = 'buffering';
        gate ??= await waitForPieceGate(state, ctx.backend, playSignal, waitMs);
        await gate(start, end);
        phase = 'streaming';
      } : undefined;
      const deadline = Date.now() + waitMs;
      let location = state.torrent;
      let diskFile = file;
      for (;;) {
        playSignal.throwIfAborted();
        try { opened = await openTorrentFile(location, diskFile, ctx.config.downloadDir, ctx.backend.pathMappings); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || file.progress >= 1) throw error;
          if (Date.now() >= deadline) throw new BufferingError(NOT_MOUNTED);
          await sleep(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal: playSignal });
          const probe = AbortSignal.any([playSignal, AbortSignal.timeout(Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())))]);
          const current = await ctx.backend.get(state.record.infoHash, probe);
          if (!current || !isOwned(state.record, current, ctx.backend)) throw new BufferingError('Torrent unavailable.');
          location = current;
          // Completion can rename/move the file between preparation and open.
          const files = await ctx.backend.getFiles(state.record.infoHash, probe);
          diskFile = files.find(f => f.id === file.id && f.path === file.path && f.bytes === file.bytes) ?? diskFile;
        }
      }
      if (file.progress >= 1 && (await opened.stat()).size !== file.bytes) {
        json(response, 502, { error: NOT_MOUNTED, code: 'not_mounted' }); return;
      }
      if (ctx.retention.extendOnPlay) {
        await ctx.store.renew(state.record.infoHash, Date.now() + (state.record.origin === 'store' ? ctx.retention.storeLeaseDays : ctx.retention.days) * DAY_MS).catch(() => {});
      }
      if (file.progress >= 1) phase = 'streaming';
      await serveFile(request, response, opened, file.path, {
        size: file.bytes, signal: playSignal, waitMs, ...(beforeRead ? { beforeRead } : {}),
      });
    } catch (error) {
      if (disconnected.signal.aborted) return;
      log.warn(`Debridarr playback ${label}: read_failed phase=${phase} elapsed=${Date.now() - startedAt}ms`);
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof BufferingError || (file.progress < 1 && !['ELOOP', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))) {
        json(response, 503, { status: 'downloading', progress: Number(file.progress.toFixed(4)),
          name: state.record.name, code: 'downloading', error: 'Playback is buffering. Retry shortly; check download progress and the shared mount if this persists.',
        }, { 'Retry-After': '15' });
        return;
      }
      if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        json(response, 502, { error: NOT_MOUNTED, code: 'not_mounted' }); return;
      }
      throw error;
    } finally { await opened?.close(); }
  } finally {
    response.off('close', close);
    markInactive(state.record.infoHash);
  }
}
