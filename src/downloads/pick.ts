import type { TorrentFile } from '../backends/torrent.js';
import { parseReleaseTitle } from '../search/parse.js';

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg)$/i;
const JUNK = /(^|[/\\])(sample|extras?|featurettes?|behind.the.scenes)([/\\]|[. _-])/i;
const SAMPLE_MAX = 300 * 1024 * 1024;

export const isVideoFile = (name: string): boolean => VIDEO.test(name);

export interface PickTarget {
  // Absent for a bare store torrent with no known media — treated like a movie
  // (largest video / single video).
  type?: 'movie' | 'series';
  season?: number;
  episode?: number;
}

export function playable(file: TorrentFile): boolean {
  if (!VIDEO.test(file.path)) return false;
  if (/\bsample\b/i.test(file.path) && file.bytes < SAMPLE_MAX) return false;
  return !JUNK.test(file.path);
}

// Choose the file to stream. Movies: the largest video. Series: the file whose
// name carries the wanted season+episode; if none does and there is exactly one
// video, use it (single-episode torrent); otherwise give up rather than guess.
export function pickFile(files: TorrentFile[], target: PickTarget): TorrentFile | undefined {
  const videos = files.filter(playable);
  if (videos.length === 0) return undefined;
  const largest = () => videos.reduce((best, file) => (file.bytes > best.bytes ? file : best));

  if (target.type !== 'series' || target.season === undefined || target.episode === undefined) {
    return largest();
  }
  const matches = videos.filter(file => {
    const parsed = parseReleaseTitle(file.path.replace(/.*[/\\]/, ''));
    return parsed.season === target.season && parsed.episode === target.episode;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches.reduce((best, file) => (file.bytes > best.bytes ? file : best));
  return videos.length === 1 ? videos[0] : undefined;
}

// The episode files that make up a season pack, so a deliberate "download the
// season" choice keeps them all downloading — the next episode is ready without
// re-preparing — rather than fetching one and parking the rest. Returns just
// [picked] when the torrent holds a single episode for the wanted season, or
// when the sibling names can't be read.
export function seasonPackFiles(files: TorrentFile[], picked: TorrentFile, target: PickTarget): TorrentFile[] {
  if (target.type !== 'series' || target.season === undefined) return [picked];
  const episodes = files.filter(file => {
    if (!playable(file)) return false;
    const parsed = parseReleaseTitle(file.path.replace(/.*[/\\]/, ''));
    return parsed.episode !== undefined && (parsed.season ?? target.season) === target.season;
  });
  return episodes.length > 1 && episodes.some(file => file.id === picked.id) ? episodes : [picked];
}
