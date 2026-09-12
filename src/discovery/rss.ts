import type { Release } from './source.js';

// Shared by the Torznab client's search response and RSS saved searches:
// both consume the same RSS 2.0 + torznab:attr item shape, just with the
// protocol and indexer label supplied by the caller. Rather than pull in a
// DOM/XML parser dependency, these helpers pick known tags and attributes out
// with regexes: the format is machine-generated and narrow, unlike arbitrary
// HTML, so this stays reliable without one.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, code: string) => {
    if (code in ENTITIES) return ENTITIES[code]!;
    if (code[0] !== '#') return match;
    const codepoint = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : match;
  });
}

function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  if (!match) return undefined;
  const raw = match[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw);
  return decodeEntities(cdata ? cdata[1]!.trim() : raw);
}

// Exported for the Torznab caps response too (`<server version="...">`),
// which is the same tag-attribute shape but outside an `<item>`.
export function attrValue(xml: string, tag: string, attr: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`, 'i').exec(xml);
  return match ? decodeEntities(match[1]!) : undefined;
}

function torznabAttr(xml: string, name: string): string | undefined {
  const match = new RegExp(`<torznab:attr\\s+name="${name}"\\s+value="([^"]*)"`, 'i').exec(xml);
  return match ? decodeEntities(match[1]!) : undefined;
}

function nonNegativeInt(value: string | undefined): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalizeItem(xml: string, indexer: string, protocol: Release['protocol']): Release | undefined {
  const title = tagText(xml, 'title');
  const link = tagText(xml, 'link');
  const enclosureUrl = attrValue(xml, 'enclosure', 'url');
  const href = link ?? enclosureUrl;
  const guid = tagText(xml, 'guid') ?? href;
  if (!title || !guid) return undefined;
  const magnetUrl = (href?.startsWith('magnet:') ? href : undefined) ?? torznabAttr(xml, 'magneturl');
  const downloadUrl = href && !href.startsWith('magnet:') ? href : undefined;
  const size = nonNegativeInt(attrValue(xml, 'enclosure', 'length') ?? tagText(xml, 'size'));
  const seeders = nonNegativeInt(torznabAttr(xml, 'seeders'));
  const peers = nonNegativeInt(torznabAttr(xml, 'peers'));
  const leechers = torznabAttr(xml, 'leechers') !== undefined
    ? nonNegativeInt(torznabAttr(xml, 'leechers')) : Math.max(peers - seeders, 0);
  const infoHash = magnetUrl ? /btih:([a-f0-9]{40})/i.exec(magnetUrl)?.[1]?.toLowerCase() : undefined;
  const publishDate = tagText(xml, 'pubDate');
  return {
    title, size, seeders, leechers, indexer, protocol, guid,
    ...(infoHash ? { infoHash } : {}),
    ...(magnetUrl ? { magnetUrl } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(publishDate ? { publishDate } : {}),
  };
}

export const RSS_RESPONSE_BYTES = 4 * 1024 * 1024;

export function isRssDocument(xml: string): boolean {
  return /<rss[\s>]|<channel[\s>]/i.test(xml);
}

// Case-insensitive, index-preserving search for a short ASCII tag literal.
// A regex like /<item>[\s\S]*?<\/item>/g is quadratic on a feed with many
// `<item>` openers and no closing tags (each failed lazy match rescans the
// remainder before the engine advances one character) — a single malicious
// or broken feed response can then block the event loop for minutes.
// `.toLowerCase()` on the whole document isn't a safe shortcut either: a
// handful of Unicode code points (e.g. U+0130) change length when
// lowercased, which would desynchronize indices from the original string.
function indexOfTag(xml: string, tag: string, from: number): number {
  const lower = tag.toLowerCase();
  outer: for (let i = from; i <= xml.length - lower.length; i++) {
    for (let j = 0; j < lower.length; j++) {
      const code = xml.charCodeAt(i + j);
      const folded = code >= 65 && code <= 90 ? code + 32 : code;
      if (folded !== lower.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

export function parseRssItems(xml: string, indexer: string, protocol: Release['protocol'], limit: number): Release[] {
  const releases: Release[] = [];
  let pos = 0;
  for (let count = 0; count < limit; count++) {
    const start = indexOfTag(xml, '<item>', pos);
    if (start < 0) break;
    const end = indexOfTag(xml, '</item>', start + 6);
    if (end < 0) break;
    const itemEnd = end + 7;
    const release = normalizeItem(xml.slice(start, itemEnd), indexer, protocol);
    if (release) releases.push(release);
    pos = itemEnd;
  }
  return releases;
}
