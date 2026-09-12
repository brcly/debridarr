import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSavedSettings, seedSettings, applySettingsPatch, writeSettings, SettingsStorageError, type Settings } from '../../settings.js';

export class JsonSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private settings: Settings;
  private readonly writer: typeof writeSettings;
  private constructor(path: string, settings: Settings, writer: typeof writeSettings) {
    this.path = path;
    this.settings = settings;
    this.writer = writer;
  }

  static async open(dataDir: string, env: NodeJS.ProcessEnv, writer = writeSettings): Promise<JsonSettingsStore> {
    const path = join(dataDir, 'settings.json');
    let contents: string | undefined;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try { contents = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch { throw new SettingsStorageError('Cannot read settings storage. Check DATA_DIR and its permissions.'); }
    let settings: Settings;
    if (contents !== undefined) {
      try { settings = readSavedSettings(contents); }
      catch { throw new SettingsStorageError('Saved settings are invalid or unsupported. Restore settings.json from a backup; it has not been reset.'); }
      try { await chmod(path, 0o600); }
      catch { throw new SettingsStorageError('Cannot protect saved settings. Check DATA_DIR ownership.'); }
    } else {
      settings = seedSettings(env);
      try { await writer(path, settings); }
      catch { throw new SettingsStorageError('Cannot initialize settings storage. Check DATA_DIR and its permissions.'); }
    }
    return new JsonSettingsStore(path, settings, writer);
  }

  snapshot(): Settings { return structuredClone(this.settings); }

  update(input: unknown): Promise<Settings> {
    const patch = structuredClone(input);
    const operation = this.queue.then(async () => {
      const next = applySettingsPatch(this.settings, patch);
      try { await this.writer(this.path, next); }
      catch { throw new SettingsStorageError('Settings could not be saved. Previous settings remain active.'); }
      this.settings = next;
      return this.snapshot();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
