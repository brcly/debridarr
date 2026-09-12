import { displayName } from '../security/text.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PrepareTransferRequest, TransferSourceResolver } from '../application/types.js';
import type { DownloadBackend, DownloadFile, DownloadSnapshot } from '../backends/download.js';
import { magnetInfoHash, toMagnet } from './magnet.js';
import { pickFile, playable, seasonPackFiles } from './pick.js';
import { parseReleaseTitle } from '../search/parse.js';
import type { DownloadRecord } from './store.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { parseInfoHash } from './torrentFile.js';
import { isNzb, nzbIdentity } from './nzb.js';
import { validateMagnet } from '../security/torrentSource.js';
import { coordinated, ConflictError } from './coordinator.js';
import { ownershipTag, verifyOwnership } from './ownership.js';
import { Admission, BusyError } from '../security/admission.js';
import { toQueuedSource } from './store.js';
import { log } from '../log.js';
import { MANAGER_METADATA_FALLBACK_MS, REGISTER_TIMEOUT_MS } from '../timeouts.js';

export type DownloadErrorCode = 'no_infohash' | 'add_failed' | 'no_metadata' | 'no_file' | 'torrent_fetch_failed' | 'cache_missing' | 'low_space' | 'space_unknown' | 'unsupported_source';
export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  constructor(code: DownloadErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
export class QueuedAdmission extends Error {
  readonly record: DownloadRecord;
  constructor(record: DownloadRecord) {
    super('The transfer was queued until a download slot is free.');
    this.record = record;
  }
}
export const downloadErrorStatus = (error: DownloadError): number => error.code === 'low_space' ? 507 : error.code === 'space_unknown' || error.code === 'no_metadata' ? 503
  : error.code === 'cache_missing' ? 404 : error.code === 'no_file' || error.code === 'no_infohash' || error.code === 'unsupported_source' ? 422 : 502;
export const DEBRIDARR_SCOPE = 'debridarr';
export const DAY_MS = 86_400_000;
export interface DownloadState { record: DownloadRecord; torrent: DownloadSnapshot; file: DownloadFile }
export interface EnsureOptions {
  backend: DownloadBackend;
  store: DownloadsRepository;
  signal: AbortSignal;
  sourceResolver?: TransferSourceResolver;
  now?: () => number;
  retentionDays?: number;
  storeMaxActiveDownloads?: number;
  minFreeSpaceGB?: number;
  existingOnly?: boolean;
  ratioLimit?: number;
  metadataTimeoutMs?: number;
  onReady?: (state: DownloadState) => void;
  // Persist as `queued` instead of throwing BusyError when the store cap is hit.
  queueIfBusy?: boolean;
}

const preparationLimits = new WeakMap<DownloadsRepository, Admission>();
const storePreparationLimits = new WeakMap<DownloadsRepository, Admission>();
async function runPrepare(request: PrepareTransferRequest, options: EnsureOptions): Promise<DownloadState> {
  const limits = request.origin === 'store' ? storePreparationLimits : preparationLimits;
  let admission = limits.get(options.store);
  if (!admission) { admission = new Admission(2); limits.set(options.store, admission); }
  const release = admission.enter();
  try { return await prepareDownload(request, options); } finally { release(); }
}

export function ensureTransfer(request: PrepareTransferRequest, options: EnsureOptions): Promise<DownloadState> {
  return runPrepare(request, options);
}

async function prepareDownload(request: PrepareTransferRequest, options: EnsureOptions): Promise<DownloadState> {
  request = { ...request, name: displayName(request.name) || ('nzb' in request.source ? 'NZB' : 'Torrent') };
  const selectedFile = request.selection?.file;
  const requireExistingSelection = request.selection?.behavior === 'require-existing';
  const allowNewSelection = request.selection?.behavior === 'allow-select';
  const { backend, store, signal } = options;
  const now = options.now ?? Date.now;
  let infoHash: string | undefined;
  let magnet: string | undefined;
  let torrentFile: Buffer | undefined;
  let nzbFile: Buffer | undefined;
  try {
    if ('nzb' in request.source) {
      nzbFile = request.source.nzb;
    } else if ('torrent' in request.source) {
      torrentFile = request.source.torrent;
    } else if ('downloadUrl' in request.source) {
      if (!options.sourceResolver) throw new Error('Missing source resolver');
      const source = await options.sourceResolver(request.source.downloadUrl, signal);
      if (source.nzb) nzbFile = source.nzb;
      else {
        torrentFile = source.bytes;
        magnet = source.magnet;
      }
    } else if ('magnet' in request.source) {
      magnet = validateMagnet(request.source.magnet);
    } else {
      infoHash = request.source.infoHash.toLowerCase();
    }
    if (nzbFile) {
      if (!isNzb(nzbFile)) throw new Error('Invalid NZB');
      infoHash = nzbIdentity(nzbFile);
    } else {
      const actual = torrentFile ? parseInfoHash(torrentFile) : magnet ? magnetInfoHash(magnet) : infoHash;
      if (!actual || (infoHash && infoHash !== actual)) throw new Error('Invalid source identity');
      infoHash = actual;
    }
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    const remote = 'downloadUrl' in request.source || 'magnet' in request.source || 'torrent' in request.source || 'nzb' in request.source;
    throw new DownloadError(remote ? 'torrent_fetch_failed' : 'no_infohash', nzbFile || 'nzb' in request.source
      ? 'Could not validate the selected NZB source.'
      : 'Could not validate the selected torrent source.');
  }
  if (!infoHash || !/^[a-f0-9]{40}$/.test(infoHash)) throw new DownloadError('no_infohash', nzbFile ? 'This NZB has no usable identity.' : 'This release has no usable infohash.');
  if (nzbFile ? backend.protocol !== 'usenet' : backend.protocol !== 'torrent') {
    throw new DownloadError('unsupported_source', nzbFile
      ? 'This download backend does not accept NZB sources.'
      : 'This download backend does not accept torrent sources.');
  }
  const hash = infoHash;
  if (store.get(hash)?.lifecycle === 'deleting') throw new ConflictError('Deletion is already in progress.');
  return coordinated(store, hash, async () => {
    signal.throwIfAborted();
    let record = store.get(hash);
    if (request.origin === 'store' && record?.origin === 'search') throw new ConflictError('This torrent is already managed by search. Use its existing addon stream.');
    if (record?.lifecycle === 'deleting') throw new ConflictError('Deletion is already in progress.');
    let torrent = await backend.get(hash, signal);
    if (requireExistingSelection && (!torrent || !record || record.lifecycle !== 'managed'
      || record.owner?.marker !== selectedFile!.marker
      || !record.selectedFiles?.some(f => f.index === selectedFile!.id && f.name === selectedFile!.path && f.bytes === selectedFile!.bytes))) {
      throw new DownloadError('cache_missing', 'This cached copy is no longer available. Refresh the stream list.');
    }
    if ((allowNewSelection || options.existingOnly) && (!torrent || !record)) throw new DownloadError('cache_missing', 'Torrent is missing from the download backend. Add it again or check the backend connection.');
    if (allowNewSelection && (record?.origin !== 'store' || record.owner?.marker !== selectedFile!.marker
      || record.lifecycle !== 'managed')) throw new ConflictError('This store file is no longer available.');
    if (torrent && !record) throw new ConflictError();
    if (torrent && record) record = await verifyOwnership(record, torrent, backend, store, signal);
    if (!torrent) {
      if (record && record.owner?.backend !== backend.identity) throw new ConflictError();
      await coordinated(store, '$registration', async () => {
        // Serialize admissions across hashes. Unknown/pending adds consume a slot.
        const origin = record?.origin ?? request.origin;
        const liveByHash = new Map((await backend.list(DEBRIDARR_SCOPE, signal)).map(t => [t.infoHash, t]));
        let incomplete = 0;
        for (const entry of store.list()) {
          if (entry.infoHash === hash || entry.owner?.backend !== backend.identity || entry.origin !== origin) continue;
          if (entry.lifecycle === 'queued') continue;
          const live = liveByHash.get(entry.infoHash);
          if (entry.lifecycle === 'registering' || !live || live.progress < 1) incomplete++;
        }
        const cap = origin === 'store' ? options.storeMaxActiveDownloads ?? 20 : 10;
        if (incomplete >= cap) {
          if (options.queueIfBusy && origin === 'store') {
            const queued = await store.upsert({
              origin: 'store', infoHash: hash, name: request.name,
              ...(request.media ? { media: request.media } : {}),
              fileIndex: record?.fileIndex ?? 0, fileName: record?.fileName ?? '', bytes: request.bytes,
              addedAt: record?.addedAt ?? now(), expiresAt: record?.expiresAt ?? now() + (options.retentionDays ?? 30) * DAY_MS,
              kept: record?.kept ?? false, lifecycle: 'queued', selectedFiles: record?.selectedFiles ?? [],
              owner: record?.owner ?? { backend: backend.identity, scope: DEBRIDARR_SCOPE, marker: ownershipTag() },
              queuedSource: toQueuedSource(request.source),
            });
            throw new QueuedAdmission(queued);
          }
          throw new BusyError();
        }
        await checkFreeSpace(backend, options.minFreeSpaceGB ?? 0, signal);
        const prior = record ? (({ queuedSource: _drop, ...rest }) => rest)(record) : undefined;
        record = await store.upsert({
          origin: prior?.origin ?? request.origin, infoHash: hash, name: request.name,
          ...(request.media ? { media: request.media } : {}),
          fileIndex: prior?.fileIndex ?? 0, fileName: prior?.fileName ?? '', bytes: request.bytes,
          addedAt: prior?.addedAt ?? now(), expiresAt: prior?.expiresAt ?? now() + (options.retentionDays ?? 30) * DAY_MS,
          kept: prior?.kept ?? false, lifecycle: 'registering', selectedFiles: prior?.selectedFiles ?? [],
          owner: prior?.owner ?? { backend: backend.identity, scope: DEBRIDARR_SCOPE, marker: ownershipTag() },
        });
        // The intent and ownership marker are durable before the first submit request.
        const source = nzbFile
          ? { type: 'nzb' as const, bytes: nzbFile }
          : torrentFile
            ? { type: 'torrent' as const, bytes: torrentFile }
            : { type: 'magnet' as const, magnet: magnet ?? toMagnet(hash, request.name) };
        await backend.submit(source, { ownership: record.owner!, stopped: true }, signal);
        torrent = await waitFor(() => backend.get(hash, signal), REGISTER_TIMEOUT_MS, now, signal);
        if (!torrent) throw new DownloadError('add_failed', 'The download backend did not register the job; its intent remains tracked.');
      });
      record = await verifyOwnership(record!, torrent!, backend, store, signal);
    }
    const ownedTorrent = torrent!;
    try {
      const stopped = /^(paused|stopped)/.test(ownedTorrent.state);
      // Run it before anything else: a magnet only fetches its metadata — and
      // therefore its file list — while running, and every configuration call
      // below needs that metadata to exist first.
      let started = false;
      if (stopped && ownedTorrent.progress < 1) { await backend.setRunning(hash, true, signal); started = true; }
      let files = await backend.getFiles(hash, signal);
      if (!files.length) files = await waitFor(async () => {
        const next = await backend.getFiles(hash, signal); return next.length ? next : undefined;
      }, options.metadataTimeoutMs ?? MANAGER_METADATA_FALLBACK_MS, now, signal) ?? [];
      const pinned = selectedFile;
      const file = pinned
        ? files.find(f => f.id === pinned.id && f.path === pinned.path && f.bytes === pinned.bytes && (!allowNewSelection || playable(f)))
        : options.existingOnly && record!.selectedFiles?.length
          ? files.find(f => f.id === record!.fileIndex && f.path === record!.fileName && f.bytes === record!.bytes)
          : pickFile(files, request.media ?? {});
      if (!file) throw new DownloadError(files.length ? 'no_file' : 'no_metadata', files.length ? 'Could not find the wanted file in this torrent.' : 'Torrent metadata is not ready.');

      const newSelection = allowNewSelection && !record!.selectedFiles?.some(f => f.index === file.id);
      if (newSelection && file.progress < 1) {
        await coordinated(store, '$registration', async () => {
          await checkFreeSpace(backend, options.minFreeSpaceGB ?? 0, signal);
          const live = new Map((await backend.list(DEBRIDARR_SCOPE, signal)).map(t => [t.infoHash, t]));
          const count = store.list().filter(r => r.origin === 'store' && r.infoHash !== hash && r.owner?.backend === backend.identity
            && r.lifecycle !== 'queued'
            && (r.lifecycle === 'registering' || !live.has(r.infoHash) || live.get(r.infoHash)!.progress < 1)).length;
          if (count >= (options.storeMaxActiveDownloads ?? 20)) throw new BusyError();
          record = await store.upsert({ ...store.get(hash)!, lifecycle: 'registering', fileIndex: file.id, fileName: file.path, bytes: file.bytes,
            selectedFiles: [...(record!.selectedFiles ?? []), { index: file.id, name: file.path, bytes: file.bytes }] });
        });
      }

      // Metadata is present now — tune the torrent. These are optimisations
      // (unlimited share limits block inherited auto-removal; sequential and
      // first/last-piece help partial streaming). A backend that
      // rejects one must not block playback; the retention sweeper reapplies
      // share limits, and each call is logged.
      const configured = await backend.get(hash, signal) ?? ownedTorrent;
      const optional = (label: string, run: Promise<void>) =>
        run.catch((error: unknown) => log.warn(`Debridarr ${label} for ${hash.slice(0, 8)} skipped: ${JSON.stringify((error as { code?: unknown }).code ?? (error as Error).message)}`));
      if (backend.capabilities.seedLimits) {
        await optional('setShareLimits', backend.capabilities.seedLimits(hash, { ratioLimit: -1, seedingTimeLimit: -1 }, signal));
      }
      if (backend.capabilities.downloadOrder && !configured.sequentialDownload) {
        await optional('setSequential', backend.capabilities.downloadOrder.sequential(hash, signal));
      }
      if (backend.capabilities.downloadOrder && !configured.firstLastPieces) {
        await optional('setFirstLastPiecePriority', backend.capabilities.downloadOrder.firstLastPieces(hash, signal));
      }

      const media = request.media;
      // Choosing a season pack downloads the whole season so the next episode
      // plays without re-preparing. A cached replay keeps whatever the original
      // selection was; a single-episode torrent still selects one file.
      const episodeFiles = request.selection ? [file] : seasonPackFiles(files, file, media ?? {});
      const selected = [...(record!.selectedFiles ?? [])];
      for (const chosen of episodeFiles) {
        const at = selected.findIndex(f => f.index === chosen.id);
        const primary = chosen.id === file.id;
        // An episode the user has already played explicitly stays explicit —
        // don't demote it to a fill-out sibling.
        if (at >= 0 && !primary && !selected[at]!.auto) continue;
        const sibling = primary ? undefined : parseReleaseTitle(chosen.path.replace(/.*[/\\]/, ''));
        const fileMedia = sibling === undefined ? media
          : media && media.season !== undefined && sibling.episode !== undefined
            ? { imdbId: media.imdbId, type: media.type, season: media.season, episode: sibling.episode }
            : undefined;
        const selectedMedia = fileMedia ?? (at >= 0 ? selected[at]!.media : undefined);
        const entry = { index: chosen.id, name: chosen.path, bytes: chosen.bytes, ...(primary ? {} : { auto: true as const }), ...(selectedMedia ? { media: selectedMedia } : {}) };
        if (at < 0) selected.push(entry);
        else selected[at] = entry;
      }
      // Persist the union before changing priorities, so a crash cannot lose selection.
      const { failure: _previousFailure, ...readyRecord } = store.get(hash)!;
      record = await store.upsert({ ...readyRecord, fileIndex: file.id, fileName: file.path, bytes: file.bytes, selectedFiles: selected });
      const wanted = new Set(selected.map(f => f.index));
      await backend.setFilesSelected(hash, files.filter(f => !wanted.has(f.id) && f.selected).map(f => f.id), false, signal);
      await backend.setFilesSelected(hash, files.filter(f => wanted.has(f.id) && !f.selected).map(f => f.id), true, signal);
      // A torrent that was complete overall but stopped (re-watch) still needs
      // starting when a newly requested file in the same pack is incomplete.
      if (!started && stopped && file.progress < 1) await backend.setRunning(hash, true, signal);
      if (record.lifecycle !== 'managed') record = await store.upsert({ ...record, lifecycle: 'managed' });
      const state = { record, torrent: configured, file };
      options.onReady?.(state); // Reserve playback before releasing the hash lock.
      return state;
    } catch (error) {
      if (error instanceof BusyError || (error instanceof DownloadError && ['low_space', 'space_unknown'].includes(error.code))) throw error;
      const code = (error as { code?: unknown }).code;
      const detail = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
      log.warn(`Debridarr preparation failed for ${hash.slice(0, 8)} (${request.name}): ${JSON.stringify(detail)}`);
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
  for (let attempt = 0; attempt <= Math.ceil(timeoutMs / 500); attempt += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    if (signal.aborted || now() >= deadline) return undefined;
    await sleep(500, undefined, { signal });
  }
  return undefined;
}


export async function checkFreeSpace(backend: DownloadBackend, minimumGB: number, signal: AbortSignal): Promise<void> {
  if (minimumGB <= 0) return;
  if (!backend.capabilities.freeSpace) {
    throw new DownloadError('space_unknown', 'The download backend cannot report free space. Disable the minimum free-space limit or choose a backend that supports it.');
  }
  let free: number;
  try { free = await backend.capabilities.freeSpace(signal); }
  catch { throw new DownloadError('space_unknown', 'Cannot check download backend free space. Check its connection before adding more files.'); }
  if (free < minimumGB * 1e9) throw new DownloadError('low_space', `The download backend has less than the required ${minimumGB} GB free. Free some space before adding more files.`);
}
