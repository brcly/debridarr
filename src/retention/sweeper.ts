import { DAY_MS, ensureDownload } from '../downloads/manager.js';
import type { DownloadsStore } from '../downloads/store.js';
import { QBittorrentClient, type QbtTorrent } from '../integrations/qbittorrent/client.js';
import { isActive as isActiveDefault } from '../playback/active.js';
import type { Settings, SettingsStore } from '../settings.js';
import { coordinated } from '../downloads/coordinator.js';
import { verifyOwnership } from '../downloads/ownership.js';
import { deleteManaged } from '../downloads/deletion.js';

export interface SweepDeps {
  store: SettingsStore;
  downloads: DownloadsStore;
  qbtFactory?: (settings: Settings['qbittorrent']) => QBittorrentClient;
  isActive?: (infoHash: string) => boolean;
  now?: () => number;
}
export interface SweepResult {
  deleted: string[]; evicted: string[]; staleRemoved: string[]; failed: string[];
  skipped?: 'qbittorrent_unconfigured' | 'qbittorrent_unreachable';
}
export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const settings = deps.store.snapshot();
  const qbt = (deps.qbtFactory ?? (s => new QBittorrentClient(s)))(settings.qbittorrent);
  const result: SweepResult = { deleted: [], evicted: [], staleRemoved: [], failed: [] };
  if (!qbt.configured) return { ...result, skipped: 'qbittorrent_unconfigured' };
  const signal = AbortSignal.timeout(60_000);
  const now = deps.now ?? Date.now;
  const active = deps.isActive ?? isActiveDefault;
  const live = new Map<string, QbtTorrent>();
  for (const snapshot of deps.downloads.list()) {
    const hash = snapshot.infoHash;
    try {
      await coordinated(deps.downloads, hash, async () => {
        const record = deps.downloads.get(hash);
        if (!record) return;
        const torrent = await qbt.torrent(hash, signal);
        if (record.owner && record.owner.client !== qbt.identity) {
          await deps.downloads.upsert({ ...record, lifecycle: 'conflict', failure: 'client_changed' });
          return;
        }
        if (!torrent) {
          if (record.owner && record.lifecycle !== 'registering' && !active(hash)) {
            await deps.downloads.remove(hash); result.staleRemoved.push(hash);
          } else if (!record.owner) await deps.downloads.upsert({ ...record, lifecycle: 'conflict', failure: 'legacy_torrent_missing' });
          return;
        }
        const verified = await verifyOwnership(record, torrent, qbt, deps.downloads, signal);
        live.set(hash, torrent);
        if (verified.lifecycle !== 'deleting') {
          await qbt.setShareLimits(hash, { ratioLimit: -1, seedingTimeLimit: -1 }, signal);
          if (torrent.progress === 1 && torrent.ratio >= settings.retention.targetRatio && !/^(paused|stopped)/.test(torrent.state)) {
            await qbt.setRunning(hash, false, signal);
          } else if (torrent.progress === 1 && torrent.ratio < settings.retention.targetRatio && /^(paused|stopped)/.test(torrent.state)) {
            await qbt.setRunning(hash, true, signal);
          }
        }
      });
      if (!live.has(hash)) continue;
      if (deps.downloads.get(hash)?.lifecycle === 'registering' && live.has(hash)) {
        const record = deps.downloads.get(hash)!;
        await ensureDownload({ ...record, title: record.name, size: record.bytes }, { qbt, store: deps.downloads, signal, retentionDays: settings.retention.days });
      }
      const removed = await deleteManaged(deps.downloads, qbt, hash, signal, (record, torrent) => {
        if (record.lifecycle === 'deleting') return true;
        if (record.kept) return false;
        if (record.lifecycle === 'failed') return true;
        return now() >= record.expiresAt && (torrent.ratio >= settings.retention.targetRatio
          || (settings.retention.graceDays > 0 && now() >= record.expiresAt + settings.retention.graceDays * DAY_MS));
      }, active);
      if (removed) { result.deleted.push(hash); live.delete(hash); }
    } catch {
      result.failed.push(hash);
    }
  }
  if (result.failed.length === deps.downloads.list().length && result.failed.length && !live.size) result.skipped = 'qbittorrent_unreachable';
  if (settings.retention.maxCacheGB > 0) {
    let total = [...live.values()].reduce((sum, t) => sum + t.size, 0);
    const candidates = deps.downloads.list().sort((a,b) => a.expiresAt - b.expiresAt);
    for (const snapshot of candidates) {
      if (total <= settings.retention.maxCacheGB * 1e9) break;
      if (!live.has(snapshot.infoHash)) continue;
      try {
        const removed = await deleteManaged(deps.downloads, qbt, snapshot.infoHash, signal,
          record => !record.kept && record.expiresAt === snapshot.expiresAt, active);
        if (removed) {
          result.evicted.push(snapshot.infoHash);
          total -= live.get(snapshot.infoHash)!.size;
        }
      } catch { if (!result.failed.includes(snapshot.infoHash)) result.failed.push(snapshot.infoHash); }
    }
  }
  return result;
}
