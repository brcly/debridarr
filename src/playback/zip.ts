import type { ServerResponse } from 'node:http';
import { openTorrentFile } from './paths.js';
import { ZipWriter } from '../archive/zip.js';
import { TransferError, type TransferService } from '../application/transfers.js';
import type { DownloadBackend } from '../backends/download.js';

export interface ZipContext {
  service: TransferService;
  backend: DownloadBackend;
  downloadDir: string;
}

// A zip-slip-safe segment: no leading slash, no `.`/`..` components. A
// torrent's file paths ultimately originate from a third-party .torrent or
// NZB, so the archive entry name gets the same treatment even though the
// on-disk open path is already confined by openTorrentFile/resolveLocalFile.
function sanitizeZipSegment(path: string): string {
  const kept = path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..');
  return kept.length ? kept.join('/') : 'file';
}

function sanitizeZipName(name: string): string {
  return name.replace(/[\\/]/g, '_').trim() || 'download';
}

export function zipContentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// Streams a zip of a transfer's eligible files straight to the response —
// never buffered in memory. Eligibility (selected-and-complete, or every
// complete video file) is TransferService's call; this only turns that list
// into on-disk read handles via the same confined path resolution playback
// uses.
export async function streamTransferZip(response: ServerResponse, infoHash: string, ctx: ZipContext, signal: AbortSignal): Promise<void> {
  const { record, files } = await ctx.service.filesForZip(infoHash);
  const torrent = await ctx.backend.get(infoHash, signal);
  if (!torrent) throw new TransferError('unavailable', 'The transfer is not available in the download backend.');
  const backendFiles = await ctx.backend.getFiles(infoHash, signal);
  const folder = sanitizeZipName(record.name);
  const entries = files.map(file => {
    const backendFile = backendFiles.find(candidate => String(candidate.id) === file.id);
    if (!backendFile) throw new TransferError('unavailable', 'A selected file is no longer available in the download backend.');
    return {
      name: `${folder}/${sanitizeZipSegment(file.path)}`,
      size: file.bytes,
      open: () => openTorrentFile(torrent, backendFile, ctx.downloadDir, ctx.backend.pathMappings),
    };
  });

  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': zipContentDisposition(`${folder}.zip`),
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const writer = new ZipWriter(response, signal);
  for (const entry of entries) await writer.addFile(entry);
  await writer.finish();
  response.end();
}
