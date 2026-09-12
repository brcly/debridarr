import { DownloadRecovery } from './downloads/recovery.js';
import { ConfigurationError, loadConfig } from './config.js';
import { DownloadsStorageError } from './downloads/store.js';
import { sweepOnce, retryDeletion } from './retention/sweeper.js';
import { JobRunner } from './jobs/runner.js';
import { createApp } from './server.js';
import { SettingsStorageError, SettingsValidationError } from './settings.js';
import { openState } from './state/init.js';
import { ImportError } from './state/importer.js';
import { SchemaVersionError, SqliteStorageError } from './state/sqlite/db.js';
import { DataDirLockedError } from './state/lock.js';
import { withWebhooks } from './webhooks/dispatch.js';
import { pollSavedSearches } from './rss/poll.js';
import { once } from 'node:events';
import { log, setLogLevel } from './log.js';
import { setTrustedProxies } from './security/clientAddress.js';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  setTrustedProxies(config.trustedProxies);
  const { settings: store, downloads: rawDownloads, storeAccess, addonAccess: access, idempotency, jobs, maintain, close } = await openState(config, process.env);
  // Wrapped once and shared with every consumer below, so a transfer becoming
  // managed/failed or a confirmed deletion notifies the webhook regardless of
  // whether an API request, recovery, or the sweep triggered it.
  const downloads = withWebhooks(rawDownloads, store);
  const server = createApp({ config, store, downloads, access, storeAccess, idempotency });
  server.on('error', () => {
    log.error('Debridarr could not start or continue listening. Check the configured port.');
    process.exit(1);
  });
  server.listen(config.port, '0.0.0.0');
  await once(server, 'listening');
  log.info(`Debridarr listening on port ${config.port}; administration: ${config.appUrl}/configure`);

  // A single bounded runner replaces the old separate setInterval loops for
  // the retention sweep, download recovery, and deletion retries. Sweep and
  // recovery are persisted recurring jobs; a deletion that fails during a
  // sweep becomes a short-backoff retry job instead of waiting for the next
  // hourly sweep.
  const recovery = new DownloadRecovery({ store, downloads });
  const runner = new JobRunner(jobs, {
    sweep: async () => {
      const result = await sweepOnce({ store, downloads });
      if (result.deleted.length || result.evicted.length || result.staleRemoved.length) {
        log.info(`Retention sweep: deleted ${result.deleted.length}, evicted ${result.evicted.length}, cleaned ${result.staleRemoved.length} stale record(s)`);
      }
      for (const hash of result.failed) runner.scheduleDeletionRetry(hash);
      await access.pruneExpired();
      maintain();
    },
    recovery: () => recovery.run(),
    deleteRetry: hash => retryDeletion(hash, { store, downloads }),
    rss: () => pollSavedSearches({ store, downloads }),
  });
  await runner.start();

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.info('Debridarr shutting down');
    const force = setTimeout(() => {
      log.error('Debridarr shutdown timed out');
      process.exit(1);
    }, 5_000);
    force.unref();
    void (async () => {
      runner.stop();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }).catch(() => { server.closeAllConnections(); });
      await runner.drain(3_000);
      close();
      clearTimeout(force);
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', error => {
    log.error('Debridarr crashed', error);
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    log.error('Debridarr unhandled rejection', reason);
  });
}

void main().catch((error: unknown) => {
  log.error(error instanceof ConfigurationError || error instanceof SettingsStorageError
    || error instanceof SettingsValidationError || error instanceof DownloadsStorageError
    || error instanceof ImportError || error instanceof SqliteStorageError
    || error instanceof SchemaVersionError || error instanceof DataDirLockedError
    ? error.message : 'Debridarr failed to start');
  process.exit(1);
});
