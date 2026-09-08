import type { MediaId, MediaType } from './id.js';

export interface ResolvedTitle {
  type: MediaType;
  imdbId: string;
  title: string;
  // Original-language title(s), when a provider exposes one distinct from
  // `title` (e.g. TMDB's original_title/original_name). Always present, even
  // when empty, since callers iterate it unconditionally.
  alternateTitles: string[];
  year?: number;
  season?: number;
  episode?: number;
}

export type MetadataErrorCode = 'not_configured' | 'not_found' | 'unavailable';

export class MetadataError extends Error {
  constructor(public readonly code: MetadataErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface MetadataProvider {
  readonly name: string;
  resolve(id: MediaId, signal: AbortSignal): Promise<ResolvedTitle>;
}

const MIN_YEAR = 1870;
const MAX_YEAR = new Date().getUTCFullYear() + 2;

export function parseYear(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(Math.trunc(value)) : typeof value === 'string' ? value : '';
  const match = /\d{4}/.exec(text);
  if (!match) return undefined;
  const year = Number(match[0]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : undefined;
}

// exactOptionalPropertyTypes forbids assigning `undefined`; build the optionals conditionally.
export function resolvedTitle(
  id: MediaId, title: string, year: number | undefined, alternateTitles: string[] = [],
): ResolvedTitle {
  return {
    type: id.type,
    imdbId: id.imdbId,
    title,
    alternateTitles,
    ...(year === undefined ? {} : { year }),
    ...(id.season === undefined ? {} : { season: id.season }),
    ...(id.episode === undefined ? {} : { episode: id.episode }),
  };
}
