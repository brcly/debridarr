import { setTimeout as sleep } from 'node:timers/promises';
import type { PlayTarget } from '../addon/play.js';
import { QBittorrentClient, type QbtFile, type QbtTorrent } from '../integrations/qbittorrent/client.js';
import { magnetInfoHash, toMagnet } from './magnet.js';
import { pickFile } from './pick.js';
import type { DownloadRecord, DownloadsStore } from './store.js';
import { parseInfoHash } from './torrentFile.js';
import { fetchTorrentSource, validateMagnet } from '../security/torrentSource.js';
import type { Settings } from '../settings.js';
import { coordinated, ConflictError } from './coordinator.js';
import { ownershipTag, verifyOwnership } from './ownership.js';
import { Admission, BusyError } from '../security/admission.js';

export type DownloadErrorCode = 'no_infohash' | 'add_failed' | 'no_metadata' | 'no_file' | 'torrent_fetch_failed';
export class DownloadError extends Error {
  constructor(public readonly code: DownloadErrorCode, message: string) { super(message); }
}
export const DEBRIDARR_CATEGORY = 'debridarr';
export const DAY_MS = 86_400_000;
const REGISTER_TIMEOUT_MS = 12_000;
const METADATA_TIMEOUT_MS = 20_000;
export interface DownloadState { record: DownloadRecord; torrent: QbtTorrent; file: QbtFile }
export interface EnsureOptions {
  qbt: QBittorrentClient;
  store: DownloadsStore;
  signal: AbortSignal;
  prowlarr?: Settings['prowlarr'];
  now?: () => number;
  retentionDays?: number;
  ratioLimit?: number;
  onReady?: (state: DownloadState) => void;
}

const preparationLimits = new WeakMap<DownloadsStore, Admission>();
export async function ensureDownload(target: PlayTarget, options: EnsureOptions): Promise<DownloadState> {
  let admission = preparationLimits.get(options.store);
  if (!admission) { admission = new Admission(2); preparationLimits.set(options.store, admission); }
  const release = admission.enter();
  try { return await prepareDownload(target, options); } finally { release(); }
}
async function prepareDownload(target: PlayTarget, options: EnsureOptions): Promise<DownloadState> {
  const { qbt, store, signal } = options;
  const now = options.now ?? Date.now;
  let infoHash = target.infoHash?.toLowerCase();
  let magnet: string | undefined;
  let torrentFile: Buffer | undefined;
  try {
    const sourceUrl = target.downloadUrl ?? (target.magnetUrl?.startsWith('http') ? target.magnetUrl : undefined);
    if (sourceUrl) {
      if (!options.prowlarr) throw new Error('Missing Prowlarr connection');
      const source = await fetchTorrentSource(sourceUrl, options.prowlarr, signal);
      torrentFile = source.bytes;
      magnet = source.magnet;
    } else if (target.magnetUrl) magnet = validateMagnet(target.magnetUrl);
    const actual = torrentFile ? parseInfoHash(torrentFile) : magnet ? magnetInfoHash(magnet) : infoHash;
    if (!actual || (infoHash && infoHash !== actual)) throw new Error('Invalid source identity');
    infoHash = actual;
  } catch {
    throw new DownloadError(target.downloadUrl || target.magnetUrl ? 'torrent_fetch_failed' : 'no_infohash', 'Could not validate the selected torrent source.');
  }
  if (!/^[a-f0-9]{40}$/.test(infoHash)) throw new DownloadError('no_infohash', 'This release has no usable infohash.');
  const hash = infoHash;
  if (store.get(hash)?.lifecycle === 'deleting') throw new ConflictError('Deletion is already in progress.');
  return coordinated(store, hash, async () => {
    signal.throwIfAborted();
    let record = store.get(hash);
    if (record?.lifecycle === 'deleting') throw new ConflictError('Deletion is already in progress.');
    let torrent = await qbt.torrent(hash, signal);
    if (torrent && !record) throw new ConflictError();
    if (torrent && record) record = await verifyOwnership(record, torrent, qbt, store, signal);
    if (!torrent) {
      if (record && record.owner?.client !== qbt.identity) throw new ConflictError();
      await coordinated(store, '$registration', async () => {
        // Serialize admissions across hashes. Unknown/pending adds consume a slot.
        let incomplete = 0;
        for (const entry of store.list()) {
          if (entry.infoHash === hash || entry.owner?.client !== qbt.identity) continue;
          const live = await qbt.torrent(entry.infoHash, signal);
          if (!live || live.progress < 1) incomplete++;
        }
        if (incomplete >= 10) throw new BusyError();
        record = await store.upsert({
          infoHash: hash, name: target.title, imdbId: target.imdbId, type: target.type,
          ...(target.season === undefined ? {} : { season: target.season }),
          ...(target.episode === undefined ? {} : { episode: target.episode }),
          fileIndex: 0, fileName: '', bytes: target.size,
          addedAt: record?.addedAt ?? now(), expiresAt: record?.expiresAt ?? now() + (options.retentionDays ?? 30) * DAY_MS,
          kept: record?.kept ?? false, lifecycle: 'registering', selectedFiles: record?.selectedFiles ?? [],
          owner: record?.owner ?? { client: qbt.identity, category: DEBRIDARR_CATEGORY, tag: ownershipTag() },
        });
        // The intent and ownership tag are durable before the first add request.
        const addOptions = { category: record.owner!.category, tags: record.owner!.tag, paused: true };
        if (torrentFile) await qbt.addTorrentFile(torrentFile, addOptions, signal);
        else await qbt.add(magnet ?? toMagnet(hash, target.title), addOptions, signal);
        torrent = await waitFor(() => qbt.torrent(hash, signal), REGISTER_TIMEOUT_MS, now, signal);
        if (!torrent) throw new DownloadError('add_failed', 'qBittorrent did not register the torrent; its intent remains tracked.');
      });
      record = await verifyOwnership(record!, torrent!, qbt, store, signal);
    }
    const ownedTorrent = torrent!;
    try {
      // Unlimited per-torrent limits prevent inherited automatic removal.
      await qbt.setShareLimits(hash, { ratioLimit: -1, seedingTimeLimit: -1 }, signal);
      if (!ownedTorrent.sequential) await qbt.setSequential(hash, signal);
      if (!ownedTorrent.firstLastPiecePrio) await qbt.setFirstLastPiecePriority(hash, signal);
      const stopped = /^(paused|stopped)/.test(ownedTorrent.state);
      // Start it before selecting a file: a magnet only fetches its metadata
      // (and therefore its file list) while running. A pack briefly downloads
      // unwanted files until the priorities below take effect.
      let started = false;
      if (stopped && ownedTorrent.progress < 1) { await qbt.setRunning(hash, true, signal); started = true; }
      let files = await qbt.files(hash, signal);
      if (!files.length) files = await waitFor(async () => {
        const next = await qbt.files(hash, signal); return next.length ? next : undefined;
      }, METADATA_TIMEOUT_MS, now, signal) ?? [];
      const file = pickFile(files, target);
      if (!file) throw new DownloadError(files.length ? 'no_file' : 'no_metadata', files.length ? 'Could not find the wanted file in this torrent.' : 'Torrent metadata is not ready.');
      const selected = [...(record!.selectedFiles ?? [])];
      if (!selected.some(f => f.index === file.index)) selected.push({ index: file.index, name: file.name, bytes: file.size });
      // Persist the union before changing priorities, so a crash cannot lose selection.
      const { failure: _previousFailure, ...readyRecord } = store.get(hash)!;
      record = await store.upsert({ ...readyRecord, lifecycle: 'managed', fileIndex: file.index, fileName: file.name, bytes: file.size, selectedFiles: selected });
      const wanted = new Set(selected.map(f => f.index));
      await qbt.setFilePriorities(hash, files.filter(f => !wanted.has(f.index) && f.priority > 0).map(f => f.index), 0, signal);
      await qbt.setFilePriorities(hash, files.filter(f => wanted.has(f.index) && f.priority === 0).map(f => f.index), 1, signal);
      // A torrent that was complete overall but stopped (re-watch) still needs
      // starting when a newly requested file in the same pack is incomplete.
      if (!started && stopped && file.progress < 1) await qbt.setRunning(hash, true, signal);
      const state = { record, torrent: ownedTorrent, file };
      options.onReady?.(state); // Reserve playback before releasing the hash lock.
      return state;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const detail = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
      console.warn(`Debridarr preparation failed for ${hash.slice(0, 8)} (${target.title}): ${detail}`);
      const current = store.get(hash)!;
      await store.upsert({ ...current, lifecycle: error instanceof DownloadError && error.code === 'no_file' && !current.selectedFiles?.length ? 'failed' : current.lifecycle ?? 'registering', failure: error instanceof DownloadError ? error.code : 'preparation_failed' });
      throw error;
    }
  });
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  now: () => number,
  signal: AbortSignal,
): Promise<T | undefined> {
  const deadline = now() + timeoutMs;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    if (signal.aborted || now() >= deadline) return undefined;
    await sleep(500, undefined, { signal });
  }
  return undefined;
}
