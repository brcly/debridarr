import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Config } from '../config.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { DEBRIDARR_SCOPE } from '../downloads/manager.js';
import { isOwned } from '../downloads/ownership.js';
import { createDownloadBackend } from '../backends/factory.js';
import type { DownloadBackend } from '../backends/download.js';
import { openTorrentFile } from '../playback/paths.js';
import type { Settings } from '../settings.js';
import { backendDescriptor } from '../backends/registry.js';
import { BACKEND_ACTION_TIMEOUT_MS, BACKEND_READ_TIMEOUT_MS } from '../timeouts.js';

interface Check { id: string; title: string; status: 'pass' | 'warning' | 'fail'; message: string }

export async function diagnostics(config: Config, settings: Settings, downloads: DownloadsRepository, backend: DownloadBackend = createDownloadBackend(settings.downloadBackend)) {
  const checks: Check[] = [];
  const backendName = backendDescriptor(settings.downloadBackend.type).label;
  const connection = await backend.test(BACKEND_READ_TIMEOUT_MS);
  checks.push({ id: 'connection', title: `${backendName} connection`, status: connection.ok ? 'pass' : 'fail', message: connection.message });
  let directoryReady = false;
  try {
    const directory = await lstat(config.downloadDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
    await access(config.downloadDir, constants.R_OK | constants.X_OK);
    directoryReady = true;
  } catch { /* Report a useful mount error without exposing internal exceptions. */ }
  checks.push({ id: 'directory', title: 'Download directory', status: directoryReady ? 'pass' : 'fail',
    message: directoryReady ? `${config.downloadDir} is readable. A file check below verifies the shared mount.`
      : `Cannot read ${config.downloadDir}. Check the complete/incomplete download mount and the container user's permissions; symlinks are unsupported.` });
  const signal = AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS);
  const [listing, space] = await Promise.allSettled([
    connection.ok ? backend.list(DEBRIDARR_SCOPE, signal) : Promise.reject(),
    connection.ok && backend.capabilities.freeSpace ? backend.capabilities.freeSpace(signal) : Promise.reject(),
  ]);
  const owned = listing.status === 'fulfilled' ? listing.value.filter(t => {
    const record = downloads.get(t.infoHash);
    return record && isOwned(record, t, backend);
  }) : [];
  let sample: Check = { id: 'file', title: 'Playback file access', status: 'warning',
    message: 'Not verified yet. Add a torrent, allow some data to download, then run this check again. A readable empty directory does not prove the mount is correct.' };
  if (connection.ok && listing.status === 'rejected') sample = { ...sample, status: 'fail', message: `Cannot list ${backendName} downloads. Check its connection and retry.` };
  if (directoryReady && connection.ok) {
    let attempted = false;
    for (const torrent of owned.slice(0, 5)) {
      try {
        const files = await backend.getFiles(torrent.infoHash, signal);
        const file = files.find(f => f.progress === 1 && f.bytes > 0) ?? files.find(f => f.progress > 0 && f.bytes > 0);
        if (!file) continue;
        attempted = true;
        const handle = await openTorrentFile(torrent, file, config.downloadDir, backend.pathMappings);
        try {
          const stat = await handle.stat();
          if (file.progress === 1 && stat.size !== file.bytes) throw new Error();
          if ((await handle.read(Buffer.alloc(1), 0, 1, 0)).bytesRead !== 1) throw new Error();
          sample = { ...sample, status: 'pass', message: `A ${backendName} file is readable through the playback path. Complete and incomplete directories must both use this shared mount.` };
          break;
        } finally { await handle.close(); }
      } catch { attempted = true; }
    }
    if (attempted && sample.status !== 'pass') sample = { ...sample, status: 'fail', message: `${backendName} has downloaded data, but Debridarr cannot read a matching file. Check paths, permissions, mappings, and the incomplete directory mount.` };
  }
  checks.push(sample);
  const freeBytes = space.status === 'fulfilled' ? space.value : null;
  const minimum = settings.retention.minFreeSpaceGB;
  checks.push({ id: 'space', title: `${backendName} free space`, status: freeBytes === null ? 'warning' : freeBytes < minimum * 1e9 ? 'fail' : 'pass',
    message: freeBytes === null ? 'Free space is unavailable. New additions are blocked while a minimum-free-space limit is enabled.'
      : `${(freeBytes / 1e9).toFixed(1)} GB free on ${backendName}'s default download filesystem; minimum ${minimum} GB. Custom download filesystems may differ.` });
  return { checks, playbackReady: connection.ok && directoryReady && sample.status === 'pass',
    storage: { freeBytes, managedBytes: owned.reduce((sum, t) => sum + t.bytes, 0), usageKnown: listing.status === 'fulfilled', minFreeSpaceGB: minimum, maxCacheGB: settings.retention.maxCacheGB } };
}
