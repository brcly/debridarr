import type { Config } from '../config.js';
import type { AddonAccessRepository, DownloadsRepository, IdempotencyRepository, JobsRepository, SettingsRepository, StoreAccessRepository } from './repositories.js';
import { JsonSettingsStore } from './json/settings.js';
import { JsonDownloadsStore } from './json/downloads.js';
import { JsonStoreAccess } from './json/access.js';
import { JsonAddonAccess } from './json/addon.js';
import { JsonIdempotencyStore } from './json/idempotency.js';
import { JsonJobsStore } from './json/jobs.js';
import { closeDatabase, maintainDatabase, openDatabase, prepareDataDir, protectDatabaseFile } from './sqlite/db.js';
import { SqliteSettingsStore } from './sqlite/settings.js';
import { SqliteDownloadsStore } from './sqlite/downloads.js';
import { SqliteStoreAccess } from './sqlite/access.js';
import { SqliteAddonAccess } from './sqlite/addon.js';
import { SqliteIdempotencyStore } from './sqlite/idempotency.js';
import { SqliteJobsStore } from './sqlite/jobs.js';
import { importState } from './importer.js';
import { acquireDataDirLock } from './lock.js';

export interface State {
  settings: SettingsRepository;
  downloads: DownloadsRepository;
  storeAccess: StoreAccessRepository;
  addonAccess: AddonAccessRepository;
  idempotency: IdempotencyRepository;
  jobs: JobsRepository;
  maintain: () => void;
  close: () => void;
}

// Composition-root entry point: builds the four repositories from either
// driver behind `DEBRIDARR_STATE`. SQLite (the default) imports any existing
// JSON state exactly once, before anything else touches the data directory.
export async function openState(config: Config, env: NodeJS.ProcessEnv): Promise<State> {
  await prepareDataDir(config.dataDir);
  const releaseLock = acquireDataDirLock(config.dataDir);
  try {
    if (config.stateDriver === 'json') {
      const settings = await JsonSettingsStore.open(config.dataDir, env);
      const downloads = await JsonDownloadsStore.open(config.dataDir);
      const storeAccess = await JsonStoreAccess.open(config.dataDir);
      const addonAccess = await JsonAddonAccess.open(config.dataDir);
      const idempotency = await JsonIdempotencyStore.open(config.dataDir);
      const jobs = await JsonJobsStore.open(config.dataDir);
      return { settings, downloads, storeAccess, addonAccess, idempotency, jobs, maintain: () => {}, close: releaseLock };
    }

    const db = openDatabase(config.dataDir);
    try {
      await importState(config.dataDir, env, db);
      await protectDatabaseFile(config.dataDir);
      const settings = SqliteSettingsStore.open(db, env);
      const downloads = new SqliteDownloadsStore(db);
      const storeAccess = SqliteStoreAccess.open(db);
      const addonAccess = SqliteAddonAccess.open(db);
      const idempotency = new SqliteIdempotencyStore(db);
      const jobs = new SqliteJobsStore(db);
      return {
        settings, downloads, storeAccess, addonAccess, idempotency, jobs,
        maintain: () => maintainDatabase(db),
        close: () => { closeDatabase(db); releaseLock(); },
      };
    } catch (error) {
      closeDatabase(db);
      throw error;
    }
  } catch (error) {
    releaseLock();
    throw error;
  }
}
