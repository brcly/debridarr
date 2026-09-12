export type Resolution = 2160 | 1080 | 720 | 480;
export type Codec = 'x265' | 'x264' | 'av1' | 'xvid';

export interface ParsedRelease {
  resolution?: Resolution;
  source?: string;
  codec?: Codec;
  hdr: boolean;
  season?: number;
  episode?: number;
  seasonPack: boolean;
  year?: number;
  // The release group / uploader tag: a trailing "-GROUP" scene suffix or a
  // bracketed "[YTS.MX]" style tag. Undefined when the name has no clear one —
  // it is only ever shown as a recognition aid, never matched on.
  group?: string;
  // ISO 639-1 codes read from explicit language tags, plus the pseudo-code
  // 'multi' for MULTI/DUAL releases. Empty when the release doesn't say —
  // deliberately not assumed to be any particular language.
  languages: string[];
}

const RESOLUTIONS: [RegExp, Resolution][] = [
  [/\b(2160p|4k|uhd)\b/, 2160],
  [/\b1080[pi]\b/, 1080],
  [/\b720[pi]\b/, 720],
  [/\b(480[pi]|360p|sd)\b/, 480],
];
const SOURCES: [RegExp, string][] = [
  [/\b(blu-?ray|bdrip|brrip|bdremux|remux)\b/, 'bluray'],
  [/\bweb-?dl\b/, 'webdl'],
  [/\bweb-?rip\b/, 'webrip'],
  [/\bwebrip\b/, 'webrip'],
  [/\b(web|amzn|nf|dsnp|hmax|atvp)\b/, 'web'],
  [/\bhdtv\b/, 'hdtv'],
  [/\b(dvdrip|dvd)\b/, 'dvd'],
  [/\b(cam|ts|telesync|hdcam)\b/, 'cam'],
];
const CODECS: [RegExp, Codec][] = [
  [/\b(x265|h ?265|hevc)\b/, 'x265'],
  [/\b(x264|h ?264|avc)\b/, 'x264'],
  [/\bav1\b/, 'av1'],
  [/\bxvid\b/, 'xvid'],
];
// ISO 639-1 codes for common scene-release language tags. Deliberately no
// bare two-letter codes (too likely to collide with ordinary words) except
// where the tag itself is the code-shaped convention (VF/VFF/VFQ for French).
// 'multi' is a pseudo-code for MULTI/DUAL releases, which likely include the
// preferred language among others without saying which ones explicitly.
const LANGUAGES: [RegExp, string][] = [
  [/\b(multi|dual)\b/, 'multi'],
  [/\b(eng|english)\b/, 'en'],
  [/\b(ita|italian)\b/, 'it'],
  [/\b(vostfr|vff|vfq|vf|truefrench|french)\b/, 'fr'],
  [/\b(ger|german)\b/, 'de'],
  [/\b(esp|spanish|castellano|latino)\b/, 'es'],
  [/\b(rus|russian)\b/, 'ru'],
  [/\b(kor|korean)\b/, 'ko'],
  [/\b(jpn|japanese)\b/, 'ja'],
  [/\bhindi\b/, 'hi'],
  [/\b(ptbr|dublado|portuguese)\b/, 'pt'],
  [/\b(pol|polish)\b/, 'pl'],
  [/\b(nld|dutch|flemish)\b/, 'nl'],
  [/\b(swe|swedish)\b/, 'sv'],
];

// Bare quality/format tokens that can trail a name without being a real group.
const NON_GROUP = /^(x?26[45]|h ?26[45]|hevc|avc|hdr(10)?\+?|dv|dovi|remux|proper|repack|internal|extended|uncut|imax|hybrid|\d{3,4}p|\d{1,2}bit|amzn|nf|dsnp|atvp|ddp?5|dts|aac|eac3)$/i;

// Reads the trailing "-GROUP" scene suffix or a bracketed "[YTS.MX]" style tag.
// Case is preserved for display. Lenient: an ambiguous ending yields undefined
// rather than a guess.
function releaseGroup(title: string): string | undefined {
  const normalized = title.trim().replace(/\.(mkv|mp4|avi|m4v|ts)$/i, '').replace(/\s+/g, '.');
  const tag = (/[[(]([A-Za-z0-9][\w.-]{1,23})[\])]$/.exec(normalized) ?? /-([A-Za-z0-9]{2,20})$/.exec(normalized))?.[1];
  return tag && !NON_GROUP.test(tag) ? tag : undefined;
}

function firstMatch<T>(text: string, table: [RegExp, T][]): T | undefined {
  for (const [pattern, value] of table) if (pattern.test(text)) return value;
  return undefined;
}
function allMatches<T>(text: string, table: [RegExp, T][]): T[] {
  const found: T[] = [];
  for (const [pattern, value] of table) {
    if (pattern.test(text) && !found.includes(value)) found.push(value);
  }
  return found;
}

// Parses a scene/p2p style release name for the attributes ranking and matching
// need. Deliberately lenient: anything it cannot read is left undefined.
export function parseReleaseTitle(title: string): ParsedRelease {
  const text = ` ${title.toLowerCase().replace(/[._]+/g, ' ')} `;

  const episodeRange = /\bs(\d{1,4})[ ]?e(\d{1,4})[ ]?[-]?[ ]?e(\d{1,4})\b/.exec(text);
  const single = /\bs(\d{1,4})[ ]?e(\d{1,4})\b/.exec(text);
  const seasonWord = /\b(?:season|series)[ ](\d{1,4})\b/.exec(text);
  const seasonToken = /\bs(\d{1,4})\b(?![ ]?e\d)/.exec(text);
  const complete = /\b(complete|all[ ]seasons)\b/.test(text);
  // A span of seasons ("S01-S03", "seasons 1-5") is a whole-series torrent, not
  // one season — leave the season number unset so it reads as a full-series pack.
  const seasonSpan = /\bs\d{1,4}[ ]?-[ ]?s?\d{1,4}\b/.test(text) || /\bseasons[ ]\d{1,4}[ ]?-[ ]?\d{1,4}\b/.test(text);

  let season: number | undefined;
  let episode: number | undefined;
  let seasonPack = false;
  if (episodeRange) {
    season = Number(episodeRange[1]);
    seasonPack = true;
  } else if (single) {
    season = Number(single[1]);
    episode = Number(single[2]);
  } else if (seasonSpan) {
    seasonPack = true;
  } else if (seasonWord || seasonToken) {
    season = Number((seasonWord ?? seasonToken)![1]);
    seasonPack = true;
  } else if (complete) {
    seasonPack = true;
  }

  const resolution = firstMatch(text, RESOLUTIONS);
  const source = firstMatch(text, SOURCES);
  const codec = firstMatch(text, CODECS);
  const languages = allMatches(text, LANGUAGES);
  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(text);
  const group = releaseGroup(title);

  return {
    hdr: /\b(hdr|hdr10\+?|dolby[ ]vision|dovi)\b/.test(text),
    seasonPack,
    languages,
    ...(group === undefined ? {} : { group }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(source === undefined ? {} : { source }),
    ...(codec === undefined ? {} : { codec }),
    ...(season === undefined ? {} : { season }),
    ...(episode === undefined ? {} : { episode }),
    ...(yearMatch ? { year: Number(yearMatch[1]) } : {}),
  };
}
