import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

// Translate a qBittorrent file (its save path + the file's relative name) to a
// path Debridarr can open, and refuse anything outside DOWNLOAD_DIR.
//
// Two layouts are handled: qBittorrent and Debridarr mount the download tree at
// the same path (use the path as-is), or Debridarr mounts it at DOWNLOAD_DIR
// (swap the save-path prefix). A prefix-remap setting for stranger layouts is a
// later addition.
export function resolveLocalFile(savePath: string, fileName: string, downloadDir: string): string | undefined {
  if (posix.isAbsolute(fileName) || fileName.split('/').some(c => c === '..' || c === '.' || c === '')) return undefined;
  const root = resolve(downloadDir);
  const candidates = [
    posix.join(savePath, fileName),
    posix.join(downloadDir, fileName),
  ];
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
