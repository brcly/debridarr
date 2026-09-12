import { setTimeout as sleep } from 'node:timers/promises';
import type { DownloadState } from '../downloads/manager.js';
import { isOwned } from '../downloads/ownership.js';
import type { DownloadBackend } from '../backends/download.js';
import { ConnectionError } from '../integrations/http.js';
import { DEFAULT_BUFFER_WAIT_MS, PROBE_TIMEOUT_MS } from '../timeouts.js';

export class BufferingError extends Error {}
class TorrentUnavailableError extends BufferingError {}

function retryable(error: unknown): boolean {
  return !(error instanceof TorrentUnavailableError)
    && (error instanceof BufferingError || error instanceof TypeError
      || (error instanceof ConnectionError && error.code !== 'authentication' && error.code !== 'not_configured')
      || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)));
}

// Newly registered magnets can expose a file list before usable piece data.
// Keep the same playback request and selection while that data becomes ready.
export async function waitForPieceGate(state: DownloadState, backend: DownloadBackend, signal: AbortSignal, waitMs = DEFAULT_BUFFER_WAIT_MS): Promise<(start: number, end: number) => Promise<void>> {
  const deadline = Date.now() + waitMs;
  let current = state;
  for (;;) {
    signal.throwIfAborted();
    try { return await pieceGate(current, backend, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]), waitMs, signal); }
    catch (error) {
      if (!retryable(error) || signal.aborted || Date.now() >= deadline) throw error;
    }
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal });
    const probe = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())))]);
    try {
      const torrent = await backend.get(state.record.infoHash, probe);
      if (!torrent || !isOwned(state.record, torrent, backend)) throw new TorrentUnavailableError('Torrent unavailable.');
      const files = await backend.getFiles(state.record.infoHash, probe);
      const file = files.find(f => f.id === state.file.id && f.path === state.file.path && f.bytes === state.file.bytes);
      if (file) current = { ...state, torrent, file };
    } catch (error) { if (!retryable(error)) throw error; }
  }
}

// Backends expose inclusive piece ranges, not byte offsets within pieces.
// Check every possible intersecting piece, including a possible neighbour.
// This also handles pad files and unaligned files in multi-file/season torrents
// without incorrectly assuming that the API file list includes padding.
export function requiredPieces(range: [number, number], pieceSize: number, start: number, end: number, fileSize: number): [number, number] {
  // The known final piece further bounds the unknown offset. This avoids
  // waiting for a preceding piece when probing the very end of a video.
  const spanBytes = (range[1] - range[0]) * pieceSize;
  const offsetMin = Math.max(0, spanBytes - fileSize + 1);
  const offsetMax = Math.min(pieceSize - 1, spanBytes + pieceSize - fileSize);
  return [range[0] + Math.floor((offsetMin + start) / pieceSize), range[0] + Math.floor((offsetMax + end) / pieceSize)];
}

export async function pieceGate(state: DownloadState, backend: DownloadBackend, signal: AbortSignal, waitMs = DEFAULT_BUFFER_WAIT_MS, playSignal = signal): Promise<(start: number, end: number) => Promise<void>> {
  const pieces = backend.capabilities.pieces;
  if (!pieces) throw new TorrentUnavailableError('The download backend does not expose verified torrent pieces.');
  const range = state.file.pieceRange;
  if (!range) throw new BufferingError('Piece information is not available yet.');
  const size = await pieces.size(state.record.infoHash, AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]));
  const span = range[1] - range[0] + 1;
  if (span < Math.ceil(state.file.bytes / size) || span > Math.ceil((state.file.bytes - 1) / size) + 1) {
    throw new BufferingError('Invalid torrent piece layout.');
  }
  let states: number[] = [];
  let refreshed = 0;
  // The metadata acquisition deadline must not expire a long playback.
  return async (start, end) => {
    const deadline = Date.now() + waitMs;
    const [first, last] = requiredPieces(range, size, start, end, state.file.bytes);
    for (;;) {
      playSignal.throwIfAborted();
      if (!states.length || Date.now() - refreshed >= 500) {
        const probe = AbortSignal.any([playSignal, AbortSignal.timeout(Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())))]);
        try {
          const torrent = await backend.get(state.record.infoHash, probe);
          if (!torrent || !isOwned(state.record, torrent, backend) || /error|missingFiles|unknown/i.test(torrent.state)) {
            throw new TorrentUnavailableError('The torrent is no longer available for playback.');
          }
          states = /checking|moving/i.test(torrent.state) ? [] : await pieces.states(state.record.infoHash, probe);
          if (range[1] >= states.length) states = [];
        } catch (error) {
          if (!retryable(error)) throw error;
          states = [];
        }
        refreshed = Date.now();
      }
      let ready = true;
      for (let i = first; i <= last; i++) if (states[i] !== 2) { ready = false; break; }
      if (ready) return;
      if (Date.now() >= deadline) throw new BufferingError('Timed out buffering torrent pieces.');
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal: playSignal });
    }
  };
}
