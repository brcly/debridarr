import { setTimeout as sleep } from 'node:timers/promises';
import { displayName } from '../security/text.js';
import { deleteManaged } from '../downloads/deletion.js';
import { magnetInfoHash, toMagnet } from '../downloads/magnet.js';
import { DEBRIDARR_SCOPE, DownloadError, ensureTransfer, QueuedAdmission } from '../downloads/manager.js';
import { isVideoFile, playable } from '../downloads/pick.js';
import { admitQueuedTransfers } from '../downloads/queue.js';
import { isOwned, ownershipTag } from '../downloads/ownership.js';
import type { DownloadRecord } from '../downloads/store.js';
import type { DownloadsRepository } from '../state/repositories.js';
import { parseInfoHash, parseTorrentName } from '../downloads/torrentFile.js';
import { nzbIdentity } from '../downloads/nzb.js';
import { ConflictError, coordinated } from '../downloads/coordinator.js';
import { BusyError } from '../security/admission.js';
import type { DownloadBackend, DownloadFile, DownloadSnapshot, DownloadSource } from '../backends/download.js';
import { backendSnapshot, invalidateBackendSnapshot } from '../backends/snapshot.js';
import type {
  Transfer, TransferFile, TransferLink, TransferLinkIssuer,
  TransferLinkRequest, TransferMedia, TransferPreview, TransferSource, TransferSourceResolver, TransferStatus,
} from './types.js';
import {
  BACKEND_ACTION_TIMEOUT_MS, BACKEND_READ_TIMEOUT_MS, PREVIEW_PROBE_TIMEOUT_MS,
  TRANSFER_ACTION_TIMEOUT_MS, TRANSFER_SUBMIT_TIMEOUT_MS,
} from '../timeouts.js';

export type { DirectTransferSource, Transfer, TransferFile, TransferLink, TransferMedia, TransferPreview, TransferSource, TransferStatus } from './types.js';

// The application seam used by native and compatibility APIs. It owns transfer
// lifecycle rules but has no HTTP, Stremio, or concrete-backend dependency.

export class TransferError extends Error {
  readonly code: 'not_found' | 'bad_source' | 'unavailable' | 'not_configured';
  constructor(code: 'not_found' | 'bad_source' | 'unavailable' | 'not_configured', message: string) {
    super(message);
    this.code = code;
  }
}

export interface TransferServiceDeps {
  downloads: DownloadsRepository;
  backend: DownloadBackend;
  leaseDays: number;
  maxActiveDownloads?: number;
  minFreeSpaceGB?: number;
  // Add-only callers may omit link issuance.
  links?: TransferLinkIssuer;
  // Required to add a `downloadUrl` source (NZB or torrent from a discovery provider).
  sourceResolver?: TransferSourceResolver;
}



function sourceHash(source: TransferSource): string | undefined {
  if ('infoHash' in source) return /^[a-f0-9]{40}$/i.test(source.infoHash) ? source.infoHash.toLowerCase() : undefined;
  if ('magnet' in source) return magnetInfoHash(source.magnet);
  if ('torrent' in source) return parseInfoHash(source.torrent);
  if ('nzb' in source) return nzbIdentity(source.nzb);
  return undefined;
}

export function sourceName(source: TransferSource): string | undefined {
  if ('torrent' in source) return displayName(parseTorrentName(source.torrent) ?? '') || undefined;
  if ('magnet' in source) {
    try { return displayName(new URL(source.magnet).searchParams.get('dn') ?? '') || undefined; }
    catch { /* invalid sources are rejected before adding */ }
  }
  return undefined;
}

function toItem(record: DownloadRecord): Transfer {
  return {
    id: record.infoHash, name: record.name, bytes: record.bytes,
    addedAt: record.addedAt, expiresAt: record.expiresAt, kept: record.kept,
    lifecycle: record.lifecycle ?? 'managed',
    ...(record.media ? { media: record.media } : {}),
  };
}

export class TransferService {
  private readonly deps: TransferServiceDeps;
  constructor(deps: TransferServiceDeps) {
    this.deps = deps;
  }

  private managed(): DownloadRecord[] {
    return this.deps.downloads.list().filter(r => r.origin === 'store' && r.owner
      && (r.lifecycle === 'managed' || r.lifecycle === 'registering' || r.lifecycle === 'queued'));
  }
  private record(infoHash: string): DownloadRecord | undefined {
    const record = this.deps.downloads.get(infoHash);
    return record?.origin === 'store' && record.owner
      && (record.lifecycle === 'managed' || record.lifecycle === 'registering' || record.lifecycle === 'queued') ? record : undefined;
  }

  list(): Transfer[] {
    return this.managed().map(toItem);
  }

  get(infoHash: string): Transfer | undefined {
    const record = this.record(infoHash);
    return record ? toItem(record) : undefined;
  }

  // Add a magnet / infohash / raw `.torrent` / NZB / provider download URL.
  // `pending` means the backend has accepted it but its file list is not ready
  // yet — background recovery finishes it and it is already tracked.
  async add(input: { source: TransferSource; media?: TransferMedia; name?: string; queue?: boolean; cachedOnly?: boolean }): Promise<{ item: Transfer; pending: boolean }> {
    const hash = sourceHash(input.source);
    if (input.cachedOnly) {
      if (!hash) throw new TransferError('bad_source', 'cachedOnly requires a magnet, infohash, torrent, or NZB identity.');
      const record = this.record(hash);
      const playableFile = (record?.selectedFiles ?? []).some(file => isVideoFile(file.name) && file.bytes > 0);
      if (!record || record.lifecycle !== 'managed' || !playableFile) {
        throw new DownloadError('cache_missing', 'That source is not in this library.');
      }
      return { item: toItem(record), pending: false };
    }
    if (!this.deps.backend.configured) throw new TransferError('not_configured', 'The download backend is not connected.');
    if (!hash && !('downloadUrl' in input.source)) throw new TransferError('bad_source', 'Could not read an identity from that source.');
    const kind = 'nzb' in input.source ? 'NZB' : 'Torrent';
    const name = displayName(input.name ?? '') || sourceName(input.source) || (hash ? `${kind} ${hash.slice(0, 12)}` : kind);
    try {
      const state = await ensureTransfer(
        { source: input.source, origin: 'store', name, bytes: 0, ...(input.media ? { media: input.media } : {}) },
        {
          backend: this.deps.backend, store: this.deps.downloads, signal: AbortSignal.timeout(TRANSFER_SUBMIT_TIMEOUT_MS),
          retentionDays: this.deps.leaseDays, storeMaxActiveDownloads: this.deps.maxActiveDownloads ?? 20,
          minFreeSpaceGB: this.deps.minFreeSpaceGB ?? 0, metadataTimeoutMs: 0,
          ...(this.deps.sourceResolver ? { sourceResolver: this.deps.sourceResolver } : {}),
          ...(input.queue ? { queueIfBusy: true } : {}),
        },
      );
      invalidateBackendSnapshot(this.deps.backend.identity);
      await this.admitQueued();
      return { item: toItem(this.deps.downloads.get(state.record.infoHash) ?? state.record), pending: false };
    } catch (error) {
      if (error instanceof QueuedAdmission) {
        return { item: toItem(error.record), pending: true };
      }
      if (error instanceof ConflictError || error instanceof BusyError
        || (error instanceof DownloadError && ['low_space', 'space_unknown'].includes(error.code))) throw error;
      const tracked = hash ? this.deps.downloads.get(hash) : undefined;
      if (error instanceof DownloadError && tracked && (error.code === 'no_metadata' || error.code === 'add_failed')) {
        return { item: toItem(tracked), pending: true };
      }
      if (error instanceof DownloadError) {
        throw new TransferError(
          error.code === 'no_infohash' || error.code === 'torrent_fetch_failed' || error.code === 'unsupported_source' ? 'bad_source' : 'unavailable',
          error.message,
        );
      }
      throw error;
    }
  }

  // Cheap, batched availability — served from a short-lived category snapshot so
  // a polling caller does not hammer the backend.
  async status(infoHashes: string[]): Promise<Record<string, TransferStatus>> {
    const snap = await backendSnapshot(this.deps.backend);
    const out: Record<string, TransferStatus> = {};
    for (const raw of infoHashes) {
      const hash = raw.toLowerCase();
      const record = this.record(hash);
      const torrent = snap.byHash.get(hash);
      if (!record) { out[hash] = { state: 'missing', progress: 0, bytes: 0 }; continue; }
      // Accepted but not yet a fully registered torrent: recovery is still
      // finishing it. A polling client should wait, not treat this as a failure.
      if (record.lifecycle === 'registering' || record.lifecycle === 'queued') { out[hash] = { state: 'queued', progress: torrent?.progress ?? 0, bytes: record.bytes }; continue; }
      if (!torrent || !isOwned(record, torrent, this.deps.backend)) { out[hash] = { state: 'error', progress: 0, bytes: record.bytes }; continue; }
      out[hash] = {
        state: /checking|moving|error|missingFiles|unknown/i.test(torrent.state) ? 'error' : record.lifecycle === 'managed' && torrent.progress >= 1 ? 'ready' : 'downloading',
        progress: torrent.progress, bytes: record.bytes,
      };
    }
    return out;
  }

  selectedFiles(infoHash: string): TransferFile[] {
    return (this.record(infoHash)?.selectedFiles ?? []).map(f => ({ id: String(f.index), path: f.name, bytes: f.bytes, progress: 0, video: isVideoFile(f.name), selected: true }));
  }

  async files(infoHash: string): Promise<TransferFile[]> {
    const record = this.record(infoHash);
    if (!record) throw new TransferError('not_found', 'No such transfer.');
    const torrent = await this.deps.backend.get(record.infoHash, AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS));
    if (!torrent || !isOwned(record, torrent, this.deps.backend) || /checking|moving|error|missingFiles|unknown/i.test(torrent.state)) throw new TransferError('unavailable', 'The transfer is not available in the download backend.');
    const files = await this.deps.backend.getFiles(record.infoHash, AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS));
    return files.map(f => ({ id: String(f.id), path: f.path, bytes: f.bytes, progress: f.progress, video: playable(f), selected: !!record.selectedFiles?.some(s => s.index === f.id && s.name === f.path && s.bytes === f.bytes) }));
  }

  // Listing and creating links is read-only. The issued request can authorize
  // selection later, when the resulting URL is actually opened.
  async links(infoHash: string, fileId?: string): Promise<TransferLink[]> {
    if (!this.deps.links) {
      throw new TransferError('not_configured', 'This service instance cannot create file links.');
    }
    if (fileId !== undefined && !/^(0|[1-9][0-9]{0,8})$/.test(fileId)) throw new TransferError('bad_source', 'Invalid file id.');
    const record = this.record(infoHash);
    if (!record) throw new TransferError('not_found', 'No such transfer.');
    const files = (await this.files(infoHash)).filter(f => f.video && f.bytes > 0 && (fileId === undefined || f.id === fileId)).slice(0, 200);
    if (fileId !== undefined && !files.length) throw new TransferError('bad_source', 'No playable file with that id.');
    const requests = files.map(file => this.linkRequest(record, file));
    const urls = files.length ? await this.deps.links.issue(requests) : [];
    return files.map((file, i) => ({ url: urls[i]!, name: record.name, file }));
  }

  async link(infoHash: string, fileId?: string): Promise<TransferLink> {
    const record = this.record(infoHash);
    if (!record) throw new TransferError('not_found', 'No such transfer.');
    return (await this.links(infoHash, fileId ?? String(record.fileIndex)))[0]!;
  }

  private linkRequest(record: DownloadRecord, file: TransferFile): TransferLinkRequest {
    return { title: record.name, bytes: file.bytes, transferId: record.infoHash,
      file: { id: Number(file.id), path: file.path, bytes: file.bytes, marker: record.owner!.marker } };
  }

  // Files a zip of this transfer would contain: the explicit selection
  // (season-pack fill-ins included) once it is complete, or every complete
  // video file when nothing is explicitly selected yet. Throws ConflictError
  // when nothing qualifies — the transfer has no complete file to zip yet.
  async filesForZip(infoHash: string): Promise<{ record: DownloadRecord; files: TransferFile[] }> {
    const record = this.record(infoHash);
    if (!record) throw new TransferError('not_found', 'No such transfer.');
    const complete = (await this.files(infoHash)).filter(f => f.video && f.bytes > 0 && f.progress >= 1);
    const selected = complete.filter(f => f.selected);
    const eligible = selected.length ? selected : complete;
    if (!eligible.length) throw new ConflictError('This transfer has no complete file to zip yet.');
    return { record, files: eligible };
  }

  async select(infoHash: string, fileId: string): Promise<TransferFile> {
    const record = this.record(infoHash);
    if (!record) throw new TransferError('not_found', 'No such transfer.');
    const file = (await this.files(infoHash)).find(f => f.id === fileId && f.video && f.bytes > 0);
    if (!file) throw new TransferError('bad_source', 'No playable file with that id.');
    await ensureTransfer({
      source: { infoHash: record.infoHash }, origin: 'store', name: record.name, bytes: file.bytes,
      ...(record.media ? { media: record.media } : {}),
      selection: { file: { id: Number(file.id), path: file.path, bytes: file.bytes, marker: record.owner!.marker }, behavior: 'allow-select' },
    }, {
      backend: this.deps.backend, store: this.deps.downloads, signal: AbortSignal.timeout(TRANSFER_ACTION_TIMEOUT_MS),
      retentionDays: this.deps.leaseDays, storeMaxActiveDownloads: this.deps.maxActiveDownloads ?? 20,
      minFreeSpaceGB: this.deps.minFreeSpaceGB ?? 0, metadataTimeoutMs: 0,
    });
    invalidateBackendSnapshot(this.deps.backend.identity);
    return { ...file, selected: true };
  }

  async remove(infoHash: string): Promise<void> {
    const record = this.deps.downloads.get(infoHash.toLowerCase());
    if (!record || record.origin !== 'store' || !record.owner) throw new TransferError('not_found', 'No such transfer.');
    await deleteManaged(this.deps.downloads, this.deps.backend, infoHash.toLowerCase(), AbortSignal.timeout(TRANSFER_ACTION_TIMEOUT_MS));
    invalidateBackendSnapshot(this.deps.backend.identity);
    await this.admitQueued();
  }

  // Pause or resume a managed backend job. Queued rows have no job yet.
  async setRunning(infoHash: string, running: boolean): Promise<void> {
    const record = this.record(infoHash);
    if (!record) throw new TransferError('not_found', 'No such transfer.');
    if (record.lifecycle !== 'managed') {
      throw new TransferError('unavailable', record.lifecycle === 'queued'
        ? 'Queued transfers are not in the download backend yet.'
        : 'This transfer is still registering.');
    }
    if (!this.deps.backend.configured) throw new TransferError('not_configured', 'The download backend is not connected.');
    const signal = AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS);
    const torrent = await this.deps.backend.get(record.infoHash, signal);
    if (!torrent || !isOwned(record, torrent, this.deps.backend)) {
      throw new TransferError('unavailable', 'The transfer is not available in the download backend.');
    }
    await this.deps.backend.setRunning(record.infoHash, running, signal);
    invalidateBackendSnapshot(this.deps.backend.identity);
  }

  // Name, size, files, and seeders for a source without creating a transfer.
  // An already-tracked identity is read in place. Anything else is a stopped
  // add + files + delete probe, serialized on the hash so a concurrent add
  // cannot adopt the probe. The probe is never persisted.
  async preview(source: TransferSource): Promise<TransferPreview> {
    if ('nzb' in source || 'downloadUrl' in source) {
      throw new TransferError('bad_source', 'Preview accepts a magnet, infohash, or torrent file.');
    }
    const hash = sourceHash(source);
    if (!hash) throw new TransferError('bad_source', 'Could not read an identity from that source.');
    const existing = this.record(hash);
    if (existing?.lifecycle === 'queued') return { id: existing.infoHash, name: existing.name, bytes: existing.bytes, files: [] };
    if (existing) return this.previewOwned(existing);
    if (!this.deps.backend.configured) throw new TransferError('not_configured', 'The download backend is not connected.');
    if (this.deps.backend.protocol !== 'torrent') {
      throw new TransferError('bad_source', 'Preview of a new source requires a torrent download backend.');
    }
    return coordinated(this.deps.downloads, hash, () => this.probePreview(hash, source));
  }

  private async probePreview(hash: string, source: TransferSource): Promise<TransferPreview> {
    const raced = this.record(hash);
    if (raced?.lifecycle === 'queued') return { id: raced.infoHash, name: raced.name, bytes: raced.bytes, files: [] };
    if (raced) return this.previewOwned(raced);

    const signal = AbortSignal.timeout(PREVIEW_PROBE_TIMEOUT_MS);
    const live = await this.deps.backend.get(hash, signal);
    if (live) throw new TransferError('unavailable', 'That torrent is already in the download backend.');

    const marker = ownershipTag();
    const downloadSource = toPreviewSource(source, hash);
    let submitted = false;
    try {
      await this.deps.backend.submit(downloadSource, {
        ownership: { backend: this.deps.backend.identity, scope: DEBRIDARR_SCOPE, marker },
        stopped: true,
      }, signal);
      submitted = true;
      let torrent = await waitUntil(() => this.deps.backend.get(hash, signal), 12_000, signal);
      if (!torrent) throw new TransferError('unavailable', 'The download backend did not register the probe.');
      if (!torrent.markers.includes(marker) || torrent.scope !== DEBRIDARR_SCOPE) {
        submitted = false;
        throw new TransferError('unavailable', 'That torrent is already in the download backend.');
      }
      let files = await this.deps.backend.getFiles(hash, signal);
      if (!files.length && /^(paused|stopped)/i.test(torrent.state)) {
        await this.deps.backend.setRunning(hash, true, signal);
        files = await waitUntil(async () => {
          const next = await this.deps.backend.getFiles(hash, signal);
          return next.length ? next : undefined;
        }, 20_000, signal) ?? [];
        await this.deps.backend.setRunning(hash, false, AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS)).catch(() => {});
        torrent = await this.deps.backend.get(hash, AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS)) ?? torrent;
      }
      return toPreview(hash, torrent, files, sourceName(source) ?? '');
    } catch (error) {
      if (error instanceof TransferError || error instanceof BusyError) throw error;
      throw new TransferError('unavailable', 'Could not preview that source.');
    } finally {
      if (submitted) await this.removePreviewProbe(hash, marker);
    }
  }

  private async previewOwned(record: DownloadRecord): Promise<TransferPreview> {
    const files = await this.files(record.infoHash);
    const torrent = await this.deps.backend.get(record.infoHash, AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS));
    return {
      id: record.infoHash, name: record.name, bytes: torrent?.bytes || record.bytes, files,
      ...(torrent ? { seeders: torrent.seeders } : {}),
    };
  }

  private async removePreviewProbe(hash: string, marker: string): Promise<void> {
    try {
      const live = await this.deps.backend.get(hash, AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS));
      if (live && !live.markers.includes(marker)) return;
      if (live) await this.deps.backend.remove(hash, true, AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS));
    } catch {
      await this.deps.backend.remove(hash, true, AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS)).catch(() => {});
    }
    invalidateBackendSnapshot(this.deps.backend.identity);
  }

  private async admitQueued(): Promise<void> {
    await admitQueuedTransfers({
      downloads: this.deps.downloads,
      backend: this.deps.backend,
      leaseDays: this.deps.leaseDays,
      maxActiveDownloads: this.deps.maxActiveDownloads ?? 20,
      minFreeSpaceGB: this.deps.minFreeSpaceGB ?? 0,
      ...(this.deps.sourceResolver ? { sourceResolver: this.deps.sourceResolver } : {}),
    });
  }
}

function toPreviewSource(source: TransferSource, hash: string): DownloadSource {
  if ('torrent' in source) return { type: 'torrent', bytes: source.torrent };
  if ('magnet' in source) return { type: 'magnet', magnet: source.magnet };
  return { type: 'magnet', magnet: toMagnet(hash) };
}

function toPreview(hash: string, torrent: DownloadSnapshot, files: DownloadFile[], fallbackName?: string): TransferPreview {
  return {
    id: hash,
    name: displayName(torrent.name) || fallbackName || `Torrent ${hash.slice(0, 12)}`,
    bytes: torrent.bytes || files.reduce((sum, file) => sum + file.bytes, 0),
    seeders: torrent.seeders,
    files: files.map(file => ({
      id: String(file.id), path: file.path, bytes: file.bytes, progress: file.progress,
      video: playable(file), selected: file.selected,
    })),
  };
}

async function waitUntil<T>(probe: () => Promise<T | undefined>, timeoutMs: number, signal: AbortSignal): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    const wait = Math.min(400, deadline - Date.now());
    if (wait <= 0) break;
    try { await sleep(wait, undefined, { signal }); }
    catch { break; }
  }
  return undefined;
}
