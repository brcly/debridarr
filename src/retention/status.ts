import type { DownloadRecord } from '../downloads/store.js';
import type { TorrentSnapshot } from '../backends/torrent.js';
import type { Settings } from '../settings.js';
import { DAY_MS } from '../downloads/manager.js';

export function retentionStatus(record: DownloadRecord, torrent: TorrentSnapshot | undefined, settings: Settings['retention'], active: boolean, now = Date.now()): string {
  if (record.lifecycle === 'deleting') return 'Deletion pending — retry if it failed';
  if (active) return 'Protected while playing';
  if (record.kept) return 'Kept — automatic deletion disabled';
  if (record.lifecycle === 'registering') return 'Waiting for metadata — automatic retry scheduled';
  if (record.lifecycle === 'conflict') return 'Ownership conflict — check the download backend';
  if (record.lifecycle === 'failed') return 'Preparation failed — cleanup pending';
  if (now < record.expiresAt) return `Expires in ${Math.ceil((record.expiresAt - now) / DAY_MS)} days`;
  if (!torrent) return 'Expired — download backend status unavailable';
  if (torrent.ratio < settings.targetRatio && (!settings.graceDays || now < record.expiresAt + settings.graceDays * DAY_MS)) {
    return settings.graceDays ? 'Expired — waiting for seeding or grace period' : 'Expired — waiting for seeding (no grace deadline)';
  }
  return 'Eligible for next hourly cleanup';
}
