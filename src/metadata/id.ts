export type MediaType = 'movie' | 'series';

export interface MediaId {
  type: MediaType;
  imdbId: string;
  season?: number;
  episode?: number;
}

// Stremio stream IDs: `tt1254207` for movies, `tt0944947:1:2` for episodes.
// Season 0 is valid (specials); leading zeros and huge numbers are rejected.
export function parseMediaId(type: string, id: string): MediaId | undefined {
  if (type === 'movie' && /^tt\d{1,10}$/.test(id)) return { type: 'movie', imdbId: id };
  const episode = /^(tt\d{1,10}):(\d{1,4}):(\d{1,4})$/.exec(id);
  if (type === 'series' && episode) {
    return { type: 'series', imdbId: episode[1]!, season: Number(episode[2]), episode: Number(episode[3]) };
  }
  return undefined;
}
