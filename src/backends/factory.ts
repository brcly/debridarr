import type { Settings } from '../settings.js';
import type { DownloadBackend } from './download.js';
import { createRegisteredBackend } from './registry.js';

const cache = new Map<string, DownloadBackend>();

function cacheKey(settings: Settings['downloadBackend']): string {
  return JSON.stringify({
    id: settings.id, type: settings.type, url: settings.url,
    username: settings.username, password: settings.password, pathMappings: settings.pathMappings,
  });
}

export function createDownloadBackend(settings: Settings['downloadBackend']): DownloadBackend {
  const key = cacheKey(settings);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const backend = createRegisteredBackend(settings);
  if (cache.size >= 8) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, backend);
  return backend;
}

export function clearDownloadBackends(): void {
  cache.clear();
}
