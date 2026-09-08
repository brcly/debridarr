import { isAbsolute, resolve } from 'node:path';

export class ConfigurationError extends Error {}
export interface Config {
  port: number;
  appUrl: string;
  adminPassword: string;
  dataDir: string;
  downloadDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = env.PORT?.trim() || '7000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535');
  }
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if (!adminPassword.trim()) throw new ConfigurationError('ADMIN_PASSWORD is required');
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
  return { port, adminPassword, downloadDir, dataDir, appUrl: appUrl.origin };
}
