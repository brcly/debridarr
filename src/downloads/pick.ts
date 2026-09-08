import type { QbtFile } from '../integrations/qbittorrent/client.js';
import { parseReleaseTitle } from '../search/parse.js';

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg)$/i;
const JUNK = /(^|[/\\])(sample|extras?|featurettes?|behind.the.scenes)([/\\]|[. _-])/i;
const SAMPLE_MAX = 300 * 1024 * 1024;

export interface PickTarget {
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
}

function playable(file: QbtFile): boolean {
  if (!VIDEO.test(file.name)) return false;
  if (/\bsample\b/i.test(file.name) && file.size < SAMPLE_MAX) return false;
  return !JUNK.test(file.name);
}

// Choose the file to stream. Movies: the largest video. Series: the file whose
// name carries the wanted season+episode; if none does and there is exactly one
// video, use it (single-episode torrent); otherwise give up rather than guess.
export function pickFile(files: QbtFile[], target: PickTarget): QbtFile | undefined {
  const videos = files.filter(playable);
  if (videos.length === 0) return undefined;
  const largest = () => videos.reduce((best, file) => (file.size > best.size ? file : best));

  if (target.type === 'movie' || target.season === undefined || target.episode === undefined) {
    return largest();
  }
  const matches = videos.filter(file => {
    const parsed = parseReleaseTitle(file.name.replace(/.*[/\\]/, ''));
    return parsed.season === target.season && parsed.episode === target.episode;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches.reduce((best, file) => (file.size > best.size ? file : best));
  return videos.length === 1 ? videos[0] : undefined;
}
