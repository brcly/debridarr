import { isAbsolute, resolve } from 'node:path';
import { logLevels, type LogLevel } from './log.js';
import { parseTrustedProxies, TrustedProxyError, type TrustedProxies } from './security/clientAddress.js';
import { DEFAULT_BUFFER_WAIT_MS, DEFAULT_METADATA_WAIT_MS } from './timeouts.js';

export class ConfigurationError extends Error {}
export const stateDrivers = ['sqlite', 'json'] as const;
export type StateDriver = typeof stateDrivers[number];

export interface Config {
  port: number;
  appUrl: string;
  adminPassword: string;
  dataDir: string;
  downloadDir: string;
  stateDriver: StateDriver;
  logLevel: LogLevel;
  trustedProxies: TrustedProxies;
  // How long a playback request waits for metadata / a buffered piece before
  // giving up (see src/timeouts.ts). The two knobs worth raising on slow
  // hardware; everything else is an internal budget.
  metadataWaitMs: number;
  bufferWaitMs: number;
}

function parsePositiveMs(raw: string | undefined, name: string, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(value) || value < 1) {
    throw new ConfigurationError(`${name} must be a positive integer (milliseconds)`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = env.PORT?.trim() || '7000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535');
  }
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if (!adminPassword.trim()) throw new ConfigurationError('ADMIN_PASSWORD is required');
  if ([...adminPassword].length < 12 || Buffer.byteLength(adminPassword) > 1024) {
    throw new ConfigurationError('ADMIN_PASSWORD must contain at least 12 characters and at most 1024 UTF-8 bytes');
  }
  const downloadDir = env.DOWNLOAD_DIR?.trim() || '/downloads';
  if (!isAbsolute(downloadDir) || downloadDir.includes('\0')) {
    throw new ConfigurationError('DOWNLOAD_DIR must be an absolute path');
  }
  const dataDir = env.DATA_DIR?.trim() || resolve('data');
  if (!isAbsolute(dataDir) || dataDir.includes('\0')) {
    throw new ConfigurationError('DATA_DIR must be an absolute path');
  }
  let appUrl: URL;
  try {
    appUrl = new URL(env.APP_URL?.trim() || `http://localhost:${port}`);
    if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password ||
        appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error();
  } catch {
    throw new ConfigurationError('APP_URL must be an HTTP(S) origin without a path, credentials, query, or fragment');
  }
  const rawStateDriver = env.DEBRIDARR_STATE?.trim() || 'sqlite';
  if (!stateDrivers.includes(rawStateDriver as StateDriver)) {
    throw new ConfigurationError(`DEBRIDARR_STATE must be one of: ${stateDrivers.join(', ')}`);
  }
  let trustedProxies: TrustedProxies;
  try { trustedProxies = parseTrustedProxies(env.TRUSTED_PROXIES); }
  catch (error) { throw new ConfigurationError(error instanceof TrustedProxyError ? error.message : 'TRUSTED_PROXIES is invalid'); }
  const rawLogLevel = (env.LOG_LEVEL?.trim() || 'info').toLowerCase();
  if (!logLevels.includes(rawLogLevel as LogLevel)) {
    throw new ConfigurationError(`LOG_LEVEL must be one of: ${logLevels.join(', ')}`);
  }
  const metadataWaitMs = parsePositiveMs(env.DEBRIDARR_METADATA_WAIT_MS, 'DEBRIDARR_METADATA_WAIT_MS', DEFAULT_METADATA_WAIT_MS);
  const bufferWaitMs = parsePositiveMs(env.DEBRIDARR_BUFFER_WAIT_MS, 'DEBRIDARR_BUFFER_WAIT_MS', DEFAULT_BUFFER_WAIT_MS);
  return {
    port, adminPassword, downloadDir, dataDir, appUrl: appUrl.origin,
    stateDriver: rawStateDriver as StateDriver, logLevel: rawLogLevel as LogLevel, trustedProxies,
    metadataWaitMs, bufferWaitMs,
  };
}
