import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { SettingsStore } from '../src/settings.js';
import { DownloadsStore } from '../src/downloads/store.js';
import type { DownloadsRepository } from '../src/state/repositories.js';
import { StoreAccess } from '../src/store/access.js';
import { AddonAccess } from '../src/security/addon.js';
import { withWebhooks } from '../src/webhooks/dispatch.js';
import { listen } from './helpers.js';
import { listenFakeQbit, type FakeQbt, type FakeQbtFile } from './fake-qbt.js';

export interface AppFixture {
  dir: string;
  downloadDir: string;
  base: string;
  token: string;
  settings: Awaited<ReturnType<typeof SettingsStore.open>>;
  downloads: DownloadsRepository;
  access: Awaited<ReturnType<typeof AddonAccess.open>>;
  tokens: Awaited<ReturnType<typeof StoreAccess.open>>;
  qbt: FakeQbt;
}

export async function appFixture(t: TestContext, options: {
  mode?: 'search' | 'store' | 'both';
  prefix?: string;
  tokenName?: string;
  seedPlaybackFile?: boolean;
  files?: FakeQbtFile[];
} = {}): Promise<AppFixture> {
  const dir = await mkdtemp(join(tmpdir(), options.prefix ?? 'debridarr-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const downloadDir = options.seedPlaybackFile ? join(dir, 'downloads') : dir;
  if (options.seedPlaybackFile) {
    await mkdir(downloadDir, { recursive: true });
    await writeFile(join(downloadDir, 'movie.mkv'), Buffer.from('0123456789'.repeat(10)));
  }
  const mode = options.mode ?? 'store';
  const qbt = await listenFakeQbit(t, { savePath: downloadDir, ...(options.files ? { files: options.files } : {}) });
  const settings = await SettingsStore.open(dir, {
    DEBRIDARR_MODE: mode,
    ...(mode === 'search' ? {} : { QBITTORRENT_URL: qbt.url, QBITTORRENT_USERNAME: 'u', QBITTORRENT_PASSWORD: 'p' }),
  });
  // Wrapped the same way `index.ts` wraps it in production, so any test that
  // configures `connections.webhookUrl` exercises real delivery.
  const downloads = withWebhooks(await DownloadsStore.open(dir), settings);
  const access = await AddonAccess.open(dir);
  const tokens = await StoreAccess.open(dir);
  const { token } = await tokens.create({ name: options.tokenName ?? 'test' });
  const config = loadConfig({
    DATA_DIR: dir, DOWNLOAD_DIR: downloadDir, APP_URL: 'https://public.example', ADMIN_PASSWORD: 'test-password',
  });
  const base = await listen(createApp({ config, store: settings, downloads, access, storeAccess: tokens }), t);
  return { dir, downloadDir, base, token, settings, downloads, access, tokens, qbt };
}
