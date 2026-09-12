import type { DatabaseSync } from 'node:sqlite';
import { applySettingsPatch, currentSettingsVersion, readSavedSettings, seedSettings, SettingsStorageError, type Settings } from '../../settings.js';

export class SqliteSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseSync;
  private settings: Settings;
  private constructor(db: DatabaseSync, settings: Settings) {
    this.db = db;
    this.settings = settings;
  }

  static open(db: DatabaseSync, env: NodeJS.ProcessEnv): SqliteSettingsStore {
    const row = db.prepare('SELECT version, data FROM settings WHERE id = 1').get() as { version: number; data: string } | undefined;
    let settings: Settings;
    if (row) {
      // `data` is only ever the settings object, not the {version,settings}
      // envelope readSavedSettings expects for a JSON file — rebuild it here
      // so both storage backends share exactly one migration path. A row
      // saved by an older release must migrate on read, the same as the JSON
      // driver's settings.json; it is rewritten at the current shape on the
      // next update(), not eagerly here.
      try {
        settings = readSavedSettings(JSON.stringify({ version: row.version, settings: JSON.parse(row.data) }));
      } catch {
        throw new SettingsStorageError('Saved settings are invalid or unsupported. Restore the database from a backup; it has not been reset.');
      }
    } else {
      settings = seedSettings(env);
      db.prepare('INSERT INTO settings (id, version, data) VALUES (1, ?, ?)').run(currentSettingsVersion, JSON.stringify(settings));
    }
    return new SqliteSettingsStore(db, settings);
  }

  snapshot(): Settings { return structuredClone(this.settings); }

  update(input: unknown): Promise<Settings> {
    const patch = structuredClone(input);
    const operation = this.queue.then(async () => {
      const next = applySettingsPatch(this.settings, patch);
      try {
        this.db.prepare(
          'INSERT INTO settings (id, version, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data',
        ).run(currentSettingsVersion, JSON.stringify(next));
      } catch {
        throw new SettingsStorageError('Settings could not be saved. Previous settings remain active.');
      }
      this.settings = next;
      return this.snapshot();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
