// Source details are stored server-side and never encoded in a playback URL.
export interface PlayTarget {
  title: string;
  size: number;
  imdbId: string;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
  infoHash?: string;
  magnetUrl?: string;
  downloadUrl?: string;
}

export function isPlayTarget(value: unknown): value is PlayTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  const source = (v: unknown) => typeof v === 'string' && v.length > 0;
  return source(target.title) && /^tt\d{1,10}$/.test(String(target.imdbId))
    && Number.isFinite(target.size) && (target.size as number) >= 0
    && (target.type === 'movie' || (target.type === 'series' && Number.isInteger(target.season)
      && (target.season as number) >= 0 && Number.isInteger(target.episode) && (target.episode as number) >= 0))
    && (target.infoHash === undefined || /^[a-f0-9]{40}$/i.test(String(target.infoHash)))
    && (target.magnetUrl === undefined || source(target.magnetUrl))
    && (target.downloadUrl === undefined || source(target.downloadUrl))
    && Boolean(target.infoHash || target.magnetUrl || target.downloadUrl);
}
