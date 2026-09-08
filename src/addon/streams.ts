import { ProwlarrClient } from '../integrations/prowlarr/client.js';
import { createMetadataProvider, MetadataError, parseMediaId, type MediaId } from '../metadata/index.js';
import { findReleases, type Candidate } from '../search/index.js';
import type { Settings } from '../settings.js';
import type { PlayTarget } from './play.js';

export { parseMediaId };
export type { MediaId, MediaType } from '../metadata/index.js';

// Stremio drops stream requests that take too long; stay well under that.
const SEARCH_DEADLINE_MS = 20_000;

export interface StreamContext {
  settings: Pick<Settings, 'prowlarr' | 'metadata' | 'preferences'>;
  appUrl: string;
  issue: (targets: PlayTarget[]) => Promise<string[]>;
}

interface StremioStream {
  name: string;
  title: string;
  url: string;
  behaviorHints: { notWebReady: boolean; bingeGroup: string };
}

export function sizeLabel(bytes: number): string {
  if (bytes <= 0) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Ranked releases become server-side references; browsing never starts downloads.
export async function buildStreams(candidates: Candidate[], id: MediaId, appUrl: string, issue: StreamContext['issue']): Promise<StremioStream[]> {
  const tokens = await issue(candidates.map(({ release }) => ({
      title: release.title,
      size: release.size,
      imdbId: id.imdbId,
      type: id.type,
      ...(id.season === undefined ? {} : { season: id.season }),
      ...(id.episode === undefined ? {} : { episode: id.episode }),
      ...(release.infoHash ? { infoHash: release.infoHash } : {}),
      ...(release.magnetUrl ? { magnetUrl: release.magnetUrl } : {}),
      ...(release.downloadUrl ? { downloadUrl: release.downloadUrl } : {}),
    })));
  return candidates.map(({ release, parsed }, index): StremioStream => {
    const token = tokens[index]!;
    const tags = [
      parsed.resolution ? `${parsed.resolution}p` : undefined,
      parsed.hdr ? 'HDR' : undefined,
      parsed.source,
      sizeLabel(release.size),
      `${release.seeders} seed`,
      release.indexer,
    ].filter((tag): tag is string => Boolean(tag));
    return {
      name: `Debridarr${parsed.resolution ? ` ${parsed.resolution}p` : ''}`,
      title: `${release.title}\n${tags.join(' · ')}`,
      url: `${appUrl}/play/${token}`,
      behaviorHints: { notWebReady: true, bingeGroup: `debridarr-${parsed.resolution ?? 'sd'}` },
    };
  });
}

// Resolve the title, search Prowlarr, and present ranked releases as selectable
// Stremio streams. Browsing must never trigger a download; selecting a stream
// hits the protected playback route. Never throws: a failure
// surfaces to Stremio as "no results".
export async function getStreams(id: MediaId, context: StreamContext): Promise<{ streams: StremioStream[] }> {
  const prowlarr = new ProwlarrClient(context.settings.prowlarr);
  if (!prowlarr.configured) return { streams: [] };

  const signal = AbortSignal.timeout(SEARCH_DEADLINE_MS);
  try {
    const metadata = createMetadataProvider(context.settings.metadata);
    const candidates = await findReleases({ id, metadata, prowlarr, signal, preferences: context.settings.preferences });
    return { streams: await buildStreams(candidates, id, context.appUrl, context.issue) };
  } catch (error) {
    console.warn(`Debridarr stream search failed (${error instanceof MetadataError ? 'metadata' : 'upstream'}).`);
    return { streams: [] };
  }
}
