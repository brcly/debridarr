import type { Config } from '../config.js';
import { backendSnapshot } from '../backends/snapshot.js';
import { isOwned } from '../downloads/ownership.js';
import type { DownloadsRepository } from '../state/repositories.js';
import type { DownloadBackend } from '../backends/download.js';
import type { MediaId } from '../metadata/index.js';
import { openTorrentFile } from '../playback/paths.js';
import { parseReleaseTitle } from '../search/parse.js';
import type { PrepareTransferRequest } from '../application/types.js';
import { cachedCopyRequest, mediaOf } from './requests.js';

export interface CachedCopy { request: PrepareTransferRequest; progress: number }
export interface CacheContext { store: DownloadsRepository; backend: DownloadBackend; config: Pick<Config, 'downloadDir'> }

// Listing is read-only: never adopt, start, tune or renew a torrent while browsing.
export async function cachedCopies(id: MediaId, ctx: CacheContext, signal: AbortSignal): Promise<CachedCopy[]> {
  if (!ctx.backend.configured) return [];
  const records = ctx.store.list().filter(r => r.lifecycle === 'managed' && r.media?.imdbId === id.imdbId && r.media.type === id.type).slice(0, 30);
  if (!records.length) return [];
  const byHash = (await backendSnapshot(ctx.backend, signal).catch(() => undefined))?.byHash ?? new Map();
  const results: CachedCopy[] = [];
  for (const record of records) {
    if (signal.aborted) break;
    try {
      const torrent = byHash.get(record.infoHash);
      if (!torrent || !isOwned(record, torrent, ctx.backend) || /checking|moving|error|missingFiles|unknown/i.test(torrent.state)) continue;
      const files = await ctx.backend.getFiles(record.infoHash, signal);
      for (const selection of record.selectedFiles ?? []) {
        const file = files.find(f => f.id === selection.index && f.path === selection.name && f.bytes === selection.bytes);
        if (!file || file.bytes <= 0) continue;
        const media = selection.media;
        if (media && (media.imdbId !== id.imdbId || media.type !== id.type)) continue;
        if (id.type === 'series') {
          // Older records lack per-file identity. Prefer explicit episode names;
          // only the original episode may use a legacy single-file fallback.
          const parsed = parseReleaseTitle(file.path.replace(/.*[/\\]/, ''));
          const season = media?.season ?? parsed.season ?? record.media?.season;
          const episode = media?.episode ?? parsed.episode ?? record.media?.episode;
          if (season !== id.season || episode !== id.episode) continue;
        }
        // A season-pack sibling only becomes a listed copy once it is actually
        // downloaded — until then the fresh pack result stays selectable.
        if (selection.auto && file.progress < 1) continue;
        if (file.progress >= 1) {
          try {
            const opened = await openTorrentFile(torrent, file, ctx.config.downloadDir, ctx.backend.pathMappings);
            try { if ((await opened.stat()).size !== file.bytes) continue; }
            finally { await opened.close(); }
          } catch { continue; }
        }
        results.push({ progress: file.progress, request: cachedCopyRequest(record,
          { index: selection.index, name: selection.name, bytes: selection.bytes }, mediaOf(id)) });
      }
    } catch { /* One unavailable copy must not hide other copies or indexer results. */ }
  }
  return results.sort((a, b) => b.progress - a.progress).slice(0, 30);
}
