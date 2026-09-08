import { AddonAccess } from './security/addon.js';
import { ConfigurationError, loadConfig } from './config.js';
import { DownloadsStore, DownloadsStorageError } from './downloads/store.js';
import { sweepOnce } from './retention/sweeper.js';
import { createApp } from './server.js';
import { SettingsStore, SettingsStorageError, SettingsValidationError } from './settings.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await SettingsStore.open(config.dataDir, process.env);
  const downloads = await DownloadsStore.open(config.dataDir);
  const access = await AddonAccess.open(config.dataDir);
  const server = createApp({ config, store, downloads, access });
  server.on('error', () => {
    console.error('Debridarr could not start or continue listening. Check the configured port.');
    process.exitCode = 1;
  });
  server.listen(config.port, '0.0.0.0', () => {
    console.info(`Debridarr listening on port ${config.port}; administration: ${config.appUrl}/configure`);
  });

  // Retention sweeper: runs on startup, then hourly. Skips a tick rather than
  // overlapping if the previous sweep is still running.
  let sweeping = false;
  const runSweep = () => {
    if (sweeping) return;
    sweeping = true;
    void sweepOnce({ store, downloads })
      .then(result => {
        if (result.deleted.length || result.evicted.length || result.staleRemoved.length) {
          console.info(`Retention sweep: deleted ${result.deleted.length}, evicted ${result.evicted.length}, cleaned ${result.staleRemoved.length} stale record(s)`);
        }
      })
      .catch(() => console.error('Retention sweep failed; downloads remain tracked.'))
      .finally(() => { sweeping = false; });
  };
  runSweep();
  const sweepInterval = setInterval(runSweep, SWEEP_INTERVAL_MS);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.info('Debridarr shutting down');
    clearInterval(sweepInterval);
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 5_000);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      process.exitCode = error ? 1 : 0;
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError || error instanceof SettingsStorageError
    || error instanceof SettingsValidationError || error instanceof DownloadsStorageError
    ? error.message : 'Debridarr failed to start');
  process.exitCode = 1;
});
