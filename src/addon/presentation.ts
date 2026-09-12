import type { ParsedRelease } from '../search/parse.js';

const SOURCES: Record<string, string> = { bluray: 'BluRay', webdl: 'WEB-DL', web: 'WEB', webrip: 'WEBRip', hdtv: 'HDTV', dvd: 'DVD', cam: 'CAM' };
const CODECS: Record<string, string> = { x265: 'H.265', x264: 'H.264', av1: 'AV1', xvid: 'Xvid' };

// ISO 639-1 code -> a representative flag. This is a language cue, not a
// nationality claim; the flag is the familiar shorthand other Stremio addons
// use. 'multi' (MULTI/DUAL releases) has no country, so it gets a globe. An
// unmapped code falls back to its uppercase letters.
const FLAGS: Record<string, string> = {
  multi: '🌐', en: '🇬🇧', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', es: '🇪🇸', ru: '🇷🇺',
  ko: '🇰🇷', ja: '🇯🇵', hi: '🇮🇳', pt: '🇧🇷', pl: '🇵🇱', nl: '🇳🇱', sv: '🇸🇪',
};

export function sizeLabel(bytes: number): string {
  if (bytes <= 0) return 'Size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function resolutionLabel(resolution: number | undefined): string | undefined {
  if (!resolution) return undefined;
  return resolution >= 2160 ? '4K' : `${resolution}p`;
}

const pad = (value: number): string => String(value).padStart(2, '0');

// A one-glance marker of what a series release actually holds, so a single
// episode is never mistaken for a season pack or a whole-series torrent while
// browsing. Undefined for movies and for series names with no readable S/E.
function scopeLabel(parsed: ParsedRelease): string | undefined {
  if (parsed.episode !== undefined) {
    return parsed.season === undefined ? `E${pad(parsed.episode)}` : `S${pad(parsed.season)}E${pad(parsed.episode)}`;
  }
  if (parsed.seasonPack) return parsed.season === undefined ? 'Complete' : `Season ${parsed.season}`;
  return undefined;
}

export interface LabelOptions {
  seeders?: number;
  indexer?: string;
  // A managed copy: complete and ready, or still downloading at this fraction.
  cache?: { progress: number };
}

// Stremio renders `name` as the compact left-hand badge and `title`/`description`
// as the detail block. `title` is still widely read; the addon SDK is
// deprecating it in favour of `description`, so both carry the same text.
// The detail leads with the raw release name — so an episode is never confused
// with a season pack — then icon-tagged chips for quality, size, availability
// and language, the way other debrid addons present their results.
export function streamLabel(release: string, parsed: ParsedRelease, size: number, options: LabelOptions = {}): { name: string; title: string; description: string } {
  const cached = options.cache && options.cache.progress >= 1;
  const badge = options.cache ? (cached ? '⚡ Cached' : `⏳ ${Math.floor(options.cache.progress * 100)}%`) : undefined;
  const subtitle = [resolutionLabel(parsed.resolution), scopeLabel(parsed)].filter(Boolean).join(' · ');
  const name = [`Debridarr${badge ? ` ${badge}` : ''}`, subtitle || undefined].filter(Boolean).join('\n');

  const isSeries = parsed.seasonPack || parsed.season !== undefined || parsed.episode !== undefined;
  const quality = [SOURCES[parsed.source ?? ''], CODECS[parsed.codec ?? ''], parsed.hdr ? 'HDR' : undefined, parsed.group]
    .filter(Boolean).join(' · ');
  const availability = options.cache
    ? (cached ? '▶️ Ready to play' : '⏳ Downloading')
    : options.seeders === undefined ? undefined : `👤 ${options.seeders.toLocaleString('en-US')}`;
  const flags = parsed.languages.map(language => FLAGS[language] ?? language.toUpperCase()).join(' ');
  const stats = [
    availability,
    `💾 ${sizeLabel(size)}`,
    options.indexer && options.indexer !== 'unknown' ? `⚙️ ${options.indexer}` : undefined,
    flags || undefined,
  ].filter(Boolean).join(' · ');

  const title = [
    release.trim() || undefined,
    quality ? `${isSeries ? '📺' : '🎬'} ${quality}` : undefined,
    stats,
  ].filter(Boolean).join('\n');
  return { name, title, description: title };
}
