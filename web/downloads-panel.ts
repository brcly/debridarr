import { element, input, message } from './dom.js';
import { downloadSignature, downloadTags, expiryText, formatSize } from './pure.js';
import type { AdminApi, DownloadView } from './types.js';

interface DownloadsPanelOptions {
  api: AdminApi;
  backendLabel: () => string;
  mode: () => string;
  openAccessSettings: () => void;
}

interface TransferFile { id: string; path: string; bytes: number; progress: number; video: boolean; selected: boolean }
interface Diagnostics {
  playbackReady: boolean;
  checks: { title: string; status: string; message: string }[];
  storage: { freeBytes: number | null; managedBytes: number; usageKnown: boolean; minFreeSpaceGB: number; maxCacheGB: number };
}

const DOWNLOADS_FAST_MS = 5_000;
const DOWNLOADS_IDLE_MS = 30_000;

export function initDownloadsPanel(options: DownloadsPanelOptions) {
  const { api, backendLabel, mode, openAccessSettings } = options;
  const state = {
    request: 0,
    loading: false,
    idle: false,
    timer: 0,
    filesRequest: 0,
  };
  const settingsDialog = element<HTMLDialogElement>('settings-dialog');
  const filesDialog = element<HTMLDialogElement>('download-files-dialog');

  function stopped(item: DownloadView): boolean {
    return item.state !== null && /^(paused|stopped)/i.test(item.state);
  }

  function rowFor(item: DownloadView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'download-row';
    row.dataset.hash = item.infoHash;
    row.dataset.lifecycle = item.lifecycle ?? '';

    const main = document.createElement('div');
    main.className = 'download-main';
    const title = document.createElement('strong');
    title.textContent = item.name;
    const tags = document.createElement('span');
    tags.className = 'download-tags';
    tags.textContent = downloadTags(item) + (item.lifecycle && item.lifecycle !== 'managed' ? ` · ${item.lifecycle}` : '') + (item.failure ? ` · ${item.failure.replaceAll('_', ' ')}` : '');
    main.append(title, tags);

    const meta = document.createElement('div');
    meta.className = 'download-meta';
    meta.textContent = expiryText(item);

    const actions = document.createElement('div');
    actions.className = 'download-actions';
    const keepButton = document.createElement('button');
    keepButton.type = 'button';
    keepButton.className = 'quiet';
    keepButton.textContent = item.kept ? 'Release' : 'Keep';
    keepButton.addEventListener('click', () => void toggleKeep(item.infoHash, !item.kept, keepButton));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'quiet';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => void deleteDownload(item.infoHash, deleteButton));
    actions.append(keepButton, deleteButton);

    const paused = stopped(item);
    if (item.lifecycle === 'managed' && ((item.progress !== null && item.progress < 1) || paused)) {
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'quiet'; toggle.textContent = paused ? 'Resume' : 'Pause';
      toggle.addEventListener('click', () => {
        toggle.disabled = true; toggle.setAttribute('aria-busy', 'true');
        void api(`downloads/${item.infoHash}/${paused ? 'resume' : 'pause'}`, 'POST', {}).then(() => load())
          .catch(error => { message('downloads-feedback', (error as Error).message, 'error'); toggle.disabled = false; toggle.removeAttribute('aria-busy'); });
      });
      actions.append(toggle);
    }
    if (item.lifecycle === 'registering' || (item.lifecycle === 'managed' && item.failure)) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'quiet'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        retry.disabled = true; retry.setAttribute('aria-busy', 'true');
        void api<{ pending: boolean }>(`downloads/${item.infoHash}/retry`, 'POST', {}).then(result => {
          message('downloads-feedback', result.pending ? 'Metadata is still pending. Automatic retries will continue.' : 'Download preparation recovered.', 'success');
          return load();
        }).catch(error => { message('downloads-feedback', (error as Error).message, 'error'); retry.disabled = false; retry.removeAttribute('aria-busy'); });
      });
      actions.append(retry);
    }
    if (item.origin === 'store' && item.lifecycle === 'managed') {
      const files = document.createElement('button');
      files.type = 'button'; files.className = 'quiet'; files.textContent = 'Files';
      files.addEventListener('click', () => void showFiles(item.infoHash, item.name));
      actions.append(files);
    }
    if (item.lifecycle === 'managed' && item.progress !== null && item.progress < 1) {
      const files = document.createElement('button');
      files.type = 'button'; files.className = 'quiet'; files.textContent = 'Files';
      files.addEventListener('click', () => void showFiles(item.infoHash, item.name));
      actions.append(files);
    }

    row.append(main, meta, actions);
    row.dataset.signature = downloadSignature(item);
    return row;
  }

  function render(list: DownloadView[]): void {
    const container = element('downloads-list');
    if (list.length === 0) {
      if (!container.querySelector('.download-row') && container.querySelector('.help')) return;
      container.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'help';
      empty.append(mode() === 'search'
        ? 'No downloads yet. Install the Stremio addon and play a title. '
        : 'No downloads yet. Add a magnet, create an API token, or install the Stremio addon. ');
      const link = document.createElement('a');
      link.href = '#'; link.textContent = 'Check playback readiness in Settings.';
      link.addEventListener('click', event => { event.preventDefault(); openAccessSettings(); });
      empty.append(link); container.append(empty);
      return;
    }
    const byHash = new Map([...container.querySelectorAll<HTMLElement>('.download-row')].map(row => [row.dataset.hash ?? '', row]));
    const fragment = document.createDocumentFragment();
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    for (const item of list) {
      const signature = downloadSignature(item);
      let row = byHash.get(item.infoHash);
      if (!row || (row.dataset.signature !== signature && !row.contains(focused))) row = rowFor(item);
      fragment.append(row);
    }
    container.replaceChildren(fragment);
  }

  function active(item: DownloadView): boolean {
    return item.lifecycle === 'registering' || item.lifecycle === 'failed'
      || (item.progress !== null && item.progress < 1)
      || (item.state !== null && /download|meta|stalled|queued/i.test(item.state));
  }

  function schedule(): void {
    window.clearInterval(state.timer);
    state.timer = window.setInterval(() => void load(true), state.idle ? DOWNLOADS_IDLE_MS : DOWNLOADS_FAST_MS);
  }

  async function load(automatic = false): Promise<void> {
    if (automatic && (state.loading || document.hidden || element('workspace').hidden
      || settingsDialog.open || filesDialog.hasAttribute('open')
      || element('downloads-list').contains(document.activeElement))) return;
    const request = ++state.request;
    state.loading = true;
    try {
      const result = await api<{ downloads: DownloadView[]; upstreamAvailable: boolean }>('downloads');
      if (request !== state.request || element('workspace').hidden) return;
      render(result.downloads);
      const idle = result.upstreamAvailable && result.downloads.length > 0 && !result.downloads.some(active);
      if (idle !== state.idle) { state.idle = idle; schedule(); }
      if (!automatic || !result.upstreamAvailable) message('downloads-feedback', result.upstreamAvailable ? '' : `${backendLabel()} is unavailable. Showing saved downloads; live progress is unknown.`, result.upstreamAvailable ? '' : 'error');
    } catch (error) {
      if (request === state.request) message('downloads-feedback', (error as Error).message, 'error');
    } finally {
      if (request === state.request) state.loading = false;
    }
  }

  async function showFiles(hash: string, title: string): Promise<void> {
    const request = ++state.filesRequest;
    if (!filesDialog.open) filesDialog.showModal();
    element('download-files-title').textContent = title;
    element('download-files-list').replaceChildren();
    message('download-files-feedback', 'Loading files…');
    try {
      const { files } = await api<{ files: TransferFile[] }>(`downloads/${hash}/files`);
      if (request !== state.filesRequest) return;
      for (const file of files.filter(candidate => candidate.video)) {
        const row = document.createElement('div'); row.className = 'file-row';
        const name = document.createElement('p'); name.textContent = `${file.path} · ${formatSize(file.bytes)} · ${Math.round(file.progress * 100)}%`;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
        button.textContent = file.selected ? 'Selected' : 'Download file'; button.disabled = file.selected;
        button.addEventListener('click', () => {
          button.disabled = true;
          void api(`downloads/${hash}/files/${file.id}/select`, 'POST', {}).then(async () => { await showFiles(hash, title); await load(); })
            .catch(error => { message('download-files-feedback', (error as Error).message, 'error'); button.disabled = false; });
        });
        const permalink = document.createElement('button'); permalink.type = 'button'; permalink.className = 'quiet'; permalink.textContent = 'Copy permalink';
        permalink.addEventListener('click', () => {
          const url = `${window.location.origin}/api/admin/downloads/${hash}/files/${file.id}/go`;
          if (!navigator.clipboard) { message('download-files-feedback', url); return; }
          void navigator.clipboard.writeText(url)
            .then(() => message('download-files-feedback', 'Permalink copied. It works while you stay signed in and always serves the current file — no need to come back here for a fresh link.', 'success'))
            .catch(() => message('download-files-feedback', url, 'error'));
        });
        const actions = document.createElement('div'); actions.className = 'file-row-actions';
        actions.append(button, permalink); row.append(name, actions); element('download-files-list').append(row);
      }
      message('download-files-feedback', files.some(file => file.video) ? '' : 'No playable video files are available yet.');
    } catch (error) {
      if (request === state.filesRequest) message('download-files-feedback', (error as Error).message, 'error');
    }
  }

  async function checkPlayback(target: string, buttonId: string): Promise<void> {
    const button = element<HTMLButtonElement>(buttonId);
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    element(target).textContent = 'Checking connection, mount, and storage…';
    try {
      const result = await api<Diagnostics>('diagnostics');
      const container = element(target); container.replaceChildren();
      for (const check of result.checks) {
        const row = document.createElement('p'); row.className = `diagnostic ${check.status}`;
        const title = document.createElement('strong'); title.textContent = `${check.title}: ${check.status === 'pass' ? 'OK' : check.status === 'fail' ? 'Needs attention' : 'Not verified'}`;
        const detail = document.createElement('span'); detail.textContent = check.message;
        row.append(title, detail); container.append(row);
      }
      const usage = document.createElement('p'); usage.className = 'help';
      usage.textContent = `Managed download size: ${result.storage.usageKnown ? formatSize(result.storage.managedBytes) : 'unknown'}. Cache cap: ${result.storage.maxCacheGB ? result.storage.maxCacheGB + ' GB' : 'unlimited'}.`;
      container.append(usage);
    } catch (error) { element(target).textContent = (error as Error).message; }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  async function toggleKeep(hash: string, kept: boolean, button: HTMLButtonElement): Promise<void> {
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try { await api(`downloads/${hash}`, 'PATCH', { kept }); await load(); }
    catch (error) { message('downloads-feedback', (error as Error).message, 'error'); button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  async function deleteDownload(hash: string, button: HTMLButtonElement): Promise<void> {
    const row = element('downloads-list').querySelector<HTMLElement>(`.download-row[data-hash="${hash}"]`);
    const prompt = row?.dataset.lifecycle === 'queued'
      ? 'Remove this queued download? It has not been sent to the download client.'
      : `Delete this download from ${backendLabel()} and Debridarr? This removes the downloaded files.`;
    if (!confirm(prompt)) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try { await api(`downloads/${hash}`, 'DELETE'); await load(); }
    catch (error) { message('downloads-feedback', (error as Error).message, 'error'); button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  function syncCacheForm(): void {
    element('cache-series-fields').hidden = element<HTMLSelectElement>('cache-type').value !== 'series';
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(file);
    });
  }

  element('downloads-refresh').addEventListener('click', () => void load());
  element('download-files-close').addEventListener('click', () => filesDialog.close());
  filesDialog.addEventListener('close', () => { state.filesRequest++; });
  element('check-playback').addEventListener('click', () => void checkPlayback('dashboard-checks', 'check-playback'));
  element('setup-check-playback').addEventListener('click', () => void checkPlayback('setup-checks', 'setup-check-playback'));
  element<HTMLSelectElement>('cache-type').addEventListener('change', syncCacheForm);
  syncCacheForm();
  element('cache-file-trigger').addEventListener('click', () => input('cache-file').click());
  element('cache-file').addEventListener('change', () => {
    const file = input('cache-file').files?.[0];
    element('cache-file-trigger').textContent = file ? file.name : 'Upload .torrent';
  });
  element('cache-add').addEventListener('click', () => {
    const type = element<HTMLSelectElement>('cache-type').value;
    const imdbId = input('cache-imdb').value.trim();
    const file = element<HTMLInputElement>('cache-file').files?.[0];
    const source = input('cache-source').value.trim();
    const payload: Record<string, unknown> = { keep: input('cache-keep').checked };
    if (imdbId || type === 'series') {
      if (!/^tt\d{1,10}$/.test(imdbId)) { message('cache-feedback', 'Enter the IMDb ID, like tt1234567 — or leave it blank.', 'error'); return; }
      const media: Record<string, unknown> = { imdbId, type };
      if (type === 'series') {
        media.season = Number(input('cache-season').value); media.episode = Number(input('cache-episode').value);
        if (!Number.isInteger(media.season) || !Number.isInteger(media.episode)) { message('cache-feedback', 'Enter the season and episode numbers.', 'error'); return; }
      }
      payload.media = media;
    }
    if (!file && !source) { message('cache-feedback', 'Paste a magnet or infohash, or choose a .torrent file.', 'error'); return; }
    void (async () => {
      const button = element<HTMLButtonElement>('cache-add'); button.disabled = true;
      message('cache-feedback', `Adding — this can take a moment while ${backendLabel()} fetches the file list…`);
      try {
        if (file) payload.torrent = await fileToBase64(file); else payload.source = source;
        const result = await api<{ pending?: boolean }>('downloads', 'POST', payload);
        input('cache-source').value = ''; element<HTMLInputElement>('cache-file').value = ''; element('cache-file-trigger').textContent = 'Upload .torrent';
        message('cache-feedback', result.pending ? 'Added. Still fetching metadata — it will appear in the list shortly.' : 'Added. It is downloading now.', 'success');
        await load();
      } catch (error) { message('cache-feedback', (error as Error).message, 'error'); }
      finally { button.disabled = false; }
    })();
  });
  schedule();

  return { load, checkPlayback, syncCacheForm };
}
