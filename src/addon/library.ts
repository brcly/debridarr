import { parseReleaseTitle } from '../search/parse.js';
import type { Transfer, TransferService } from '../application/transfers.js';
import { LIBRARY_CATALOG_ID } from './manifest.js';
import { streamLabel } from './presentation.js';
import type { StremioStream } from './streams.js';
import { libraryId, parseDbId } from '../domain/ids.js';

export { libraryId, parseDbId };

export function catalogExtras(raw: string | undefined): { skip: number; search: string } {
  if (!raw) return { skip: 0, search: '' };
  const params = new URLSearchParams(raw.replaceAll('/', '&'));
  const skipRaw = params.get('skip');
  const skip = skipRaw && /^\d{1,6}$/.test(skipRaw) ? Number(skipRaw) : 0;
  return { skip, search: (params.get('search') ?? '').trim() };
}

// Stremio catalog rows for every hand-added torrent, id-less ones included.
export function libraryMetas(items: Transfer[], extras: { skip?: number; search?: string } = {}) {
  const needle = extras.search?.trim().toLowerCase();
  let metas = items.map(item => ({
    id: libraryId(item.id),
    type: 'other',
    name: item.name,
    posterShape: 'square',
    ...(item.media ? { description: `Linked to ${item.media.imdbId}` } : {}),
  }));
  if (needle) metas = metas.filter(meta => meta.name.toLowerCase().includes(needle));
  const skip = extras.skip ?? 0;
  if (skip > 0) metas = metas.slice(skip);
  return { metas };
}

export function libraryMeta(items: Transfer[], id: string): { meta: unknown } | undefined {
  const hash = parseDbId(id);
  const item = hash && items.find(i => i.id === hash);
  if (!item) return undefined;
  const metaId = libraryId(item.id);
  return { meta: {
    id: metaId,
    type: 'other',
    name: item.name,
    description: item.media ? `Linked to ${item.media.imdbId}.` : 'Added to your Debridarr library by hand.',
    behaviorHints: { defaultVideoId: metaId },
    videos: [{ id: metaId, title: item.name, released: new Date(item.addedAt).toISOString() }],
  } };
}

// Every playable file in a store torrent can be selected without starting a
// download while browsing. Never throws.
export async function getStoreStreams(id: string, service: TransferService): Promise<{ streams: StremioStream[] }> {
  const hash = parseDbId(id);
  if (!hash) return { streams: [] };
  try {
    const links = await service.links(hash);
    return { streams: links.map(({ url, file }) => ({
      ...streamLabel(file.path.split('/').at(-1)!, parseReleaseTitle(file.path), file.bytes,
        file.selected ? { cache: { progress: file.progress } } : {}),
      url,
      behaviorHints: { notWebReady: true, bingeGroup: `debridarr-store-${hash.slice(0, 8)}` },
    })) };
  } catch {
    return { streams: [] };
  }
}

export { LIBRARY_CATALOG_ID };
