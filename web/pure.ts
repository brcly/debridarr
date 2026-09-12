import type { DownloadView, PathMapping } from './types.js';

export function parsePathMappings(value: string): PathMapping[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s*=>\s*/);
    return { remote: parts[0] ?? '', local: parts.length === 2 ? parts[1] ?? '' : '' };
  });
}

export function formatPathMappings(mappings: PathMapping[]): string {
  return mappings.map(mapping => `${mapping.remote} => ${mapping.local}`).join('\n');
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function isStoppedState(state: string | null): boolean {
  return state !== null && /^(paused|stopped)/i.test(state);
}

export function downloadTags(item: DownloadView): string {
  const kind = item.type === 'series' && item.season !== undefined && item.episode !== undefined
    ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
    : item.type ?? 'download';
  const parts = [kind, formatSize(item.bytes)];
  if (item.progress !== null && item.progress < 1) parts.push(`${isStoppedState(item.state) ? 'paused' : 'downloading'} ${Math.round(item.progress * 100)}%`);
  else if (item.ratio !== null) parts.push(`ratio ${item.ratio.toFixed(2)}`);
  else parts.push('status unknown');
  return parts.join(' · ');
}

export function expiryText(item: DownloadView, now = Date.now()): string {
  if (item.retentionStatus) return item.retentionStatus;
  if (item.kept) return 'Kept — never expires';
  const daysLeft = Math.ceil((item.expiresAt - now) / 86_400_000);
  return daysLeft > 0 ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : 'Expiring soon';
}

export function downloadSignature(item: DownloadView): string {
  return [item.name, item.kept, item.progress, item.ratio, item.state, item.lifecycle, item.failure, item.retentionStatus, item.expiresAt, item.origin].join('\0');
}
