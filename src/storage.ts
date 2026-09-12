import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

// Atomic JSON write: a fresh temp file (mode 0600), fsync, then rename over the
// target. The temp file is always cleaned up. Shared by the settings and
// downloads stores.
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // Persist the directory entry too: registration intent must survive a host crash.
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
