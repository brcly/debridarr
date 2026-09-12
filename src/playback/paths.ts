import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';
import type { TorrentFile, TorrentSnapshot } from '../backends/torrent.js';
import type { PathMapping } from '../backends/config.js';

export async function openTorrentFile(torrent: TorrentSnapshot, file: TorrentFile, downloadDir: string, mappings: readonly PathMapping[] = []): Promise<FileHandle> {
  // Do not read an old same-named file in the final directory while the backend
  // is writing this torrent into its separate incomplete directory.
  const roots = file.progress < 1 && torrent.incompletePath ? [torrent.incompletePath] : [torrent.savePath];
  let lastError: unknown = Object.assign(new Error('File not found'), { code: 'ENOENT' });
  for (const root of new Set(roots)) {
    for (const name of [file.path, ...(file.incompleteSuffixes ?? []).map(suffix => `${file.path}${suffix}`)]) {
      const path = resolveLocalFile(root, name, downloadDir, mappings);
      if (!path) throw new Error('File outside download root');
      try { return await openConfinedFile(path, downloadDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        lastError = error;
      }
    }
  }
  throw lastError;
}

// Translate a backend file (its save path + the file's relative name) to a
// path Debridarr can open, and refuse anything outside DOWNLOAD_DIR.
//
// Explicit mappings handle different container mount points. Without one, try
// the backend path directly and the conventional DOWNLOAD_DIR-relative layout.
export function resolveLocalFile(savePath: string, fileName: string, downloadDir: string, mappings: readonly PathMapping[] = []): string | undefined {
  if (posix.isAbsolute(fileName) || fileName.split('/').some(c => c === '..' || c === '.' || c === '')) return undefined;
  const root = resolve(downloadDir);
  const mapping = [...mappings]
    .sort((a, b) => b.remote.length - a.remote.length)
    .find(candidate => savePath === candidate.remote || (candidate.remote === '/' ? savePath.startsWith('/') : savePath.startsWith(`${candidate.remote}/`)));
  const candidates = mapping
    ? [posix.join(mapping.local, savePath.slice(mapping.remote.length), fileName)]
    : [posix.join(savePath, fileName), posix.join(downloadDir, fileName)];
  for (const candidate of candidates) {
    const full = resolve(posix.normalize(candidate));
    if (full === root || full.startsWith(root + sep)) return full;
  }
  return undefined;
}

// Linux descriptor walk: every lookup is relative to a held directory inode.
// O_NOFOLLOW refuses final-component links at each step, even during renames.
export async function openConfinedFile(filePath: string, downloadDir: string): Promise<FileHandle> {
  if (process.platform !== 'linux') throw new Error('Secure file access requires Linux');
  const root = resolve(downloadDir);
  if (!filePath.startsWith(root + sep)) throw new Error('File outside download root');
  const components = filePath.slice(root.length + 1).split(sep);
  if (components.some(c => !c || c === '.' || c === '..')) throw new Error('Invalid file path');
  let dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of components.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await dir.close();
      dir = next;
    }
    const file = await open(`/proc/self/fd/${dir.fd}/${components.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!(await file.stat()).isFile()) throw new Error('Not a regular file'); }
    catch (error) { await file.close(); throw error; }
    return file;
  } finally { await dir.close(); }
}
