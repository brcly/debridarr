export {};

type Service = 'prowlarr' | 'qbittorrent';
interface RetentionSettings { days: number; targetRatio: number; graceDays: number; extendOnPlay: boolean; maxCacheGB: number }
interface PreferencesSettings { languages: string[]; resolutions: number[]; codecs: string[] }
interface Draft {
  prowlarr: Record<string, string | null>;
  qbittorrent: Record<string, string | null>;
  metadata: Record<string, string | null>;
  retention: RetentionSettings;
  preferences: PreferencesSettings;
}
interface PublicSettings {
  prowlarr: { url: string; hasApiKey: boolean };
  qbittorrent: { url: string; username: string; hasPassword: boolean };
  metadata: { provider: string; hasTmdbApiKey: boolean };
  retention: RetentionSettings;
  preferences: PreferencesSettings;
}
interface SettingsResponse {
  settings: PublicSettings;
  deployment: { appUrl: string; port: number; downloadDir: string };
}
interface DownloadView {
  lifecycle?: string;
  failure?: string | null;
  infoHash: string; name: string; imdbId: string; type: 'movie' | 'series';
  season?: number; episode?: number; bytes: number; addedAt: number; expiresAt: number; kept: boolean;
  ratio: number | null; progress: number | null; state: string | null; eta: number | null;
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const checkedValues = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map(el => el.value);
let csrfToken = '';
let baseline = '';
let busy = false;
const services: Service[] = ['prowlarr', 'qbittorrent'];

function message(id: string, text: string, kind = '') {
  const target = element(id);
  target.textContent = text;
  target.classList.remove('success', 'error');
  if (kind) target.classList.add(kind);
}

async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(result.error ?? 'The request failed. Try again.');
  }
  return result as T;
}

function showLogin() {
  csrfToken = '';
  element('login-panel').hidden = false;
  element('workspace').hidden = true;
  element('logout').hidden = true;
  input('admin-password').focus();
}

type Tab = 'main' | 'library' | 'connections';
const tabs: Tab[] = ['main', 'library', 'connections'];
const TAB_META: Record<Tab, { title: string; subtitle: string }> = {
  main: { title: 'Dashboard', subtitle: 'Titles Debridarr is currently caching for you.' },
  library: { title: 'Library', subtitle: 'How long titles stay cached, and what search shows you.' },
  connections: { title: 'Make the connection.', subtitle: 'Connect your services. Keep everything on your server.' },
};
function showTab(tab: Tab) {
  for (const name of tabs) {
    const active = name === tab;
    element(`tab-${name}`).hidden = !active;
    element(`tab-btn-${name}`).classList.toggle('active', active);
    element(`tab-btn-${name}`).setAttribute('aria-selected', String(active));
  }
  element('page-title').textContent = TAB_META[tab].title;
  element('page-subtitle').textContent = TAB_META[tab].subtitle;
}
for (const name of tabs) element(`tab-btn-${name}`).addEventListener('click', () => showTab(name));

function draft(): Draft {
  const provider = element<HTMLSelectElement>('metadata-provider').value;
  const daysSelect = element<HTMLSelectElement>('retention-days').value;
  const result: Draft = {
    prowlarr: { url: input('prowlarr-url').value },
    qbittorrent: { url: input('qbittorrent-url').value, username: input('qbittorrent-username').value },
    metadata: { provider },
    retention: {
      days: Number(daysSelect === 'custom' ? input('retention-days-custom').value : daysSelect),
      targetRatio: Number(input('retention-target-ratio').value),
      graceDays: Number(input('retention-grace-days').value),
      extendOnPlay: input('retention-extend-on-play').checked,
      maxCacheGB: Number(input('retention-max-cache-gb').value),
    },
    preferences: {
      languages: checkedValues('pref-language'),
      resolutions: checkedValues('pref-resolution').map(Number),
      codecs: checkedValues('pref-codec'),
    },
  };
  for (const service of services) {
    const action = element<HTMLSelectElement>(`${service}-secret-action`).value;
    const key = service === 'prowlarr' ? 'apiKey' : 'password';
    if (action === 'replace') result[service][key] = input(`${service}-secret`).value;
    if (action === 'clear') result[service][key] = null;
  }
  if (provider === 'tmdb') {
    const action = element<HTMLSelectElement>('metadata-secret-action').value;
    if (action === 'replace') result.metadata.tmdbApiKey = input('metadata-secret').value;
    if (action === 'clear') result.metadata.tmdbApiKey = null;
  }
  return result;
}

function dirty() { return baseline !== '' && JSON.stringify(draft()) !== baseline; }
function updateState() {
  const changed = dirty();
  element('save-state').textContent = changed ? 'You have unsaved changes' : 'All changes saved';
  element<HTMLButtonElement>('save').disabled = !changed || busy;
  for (const service of services) {
    const replace = element<HTMLSelectElement>(`${service}-secret-action`).value === 'replace';
    input(`${service}-secret`).disabled = !replace;
    input(`${service}-secret`).required = replace;
  }
  const tmdb = element<HTMLSelectElement>('metadata-provider').value === 'tmdb';
  element('tmdb-fields').hidden = !tmdb;
  const replaceKey = tmdb && element<HTMLSelectElement>('metadata-secret-action').value === 'replace';
  input('metadata-secret').disabled = !replaceKey;
  input('metadata-secret').required = replaceKey;

  const customDays = element<HTMLSelectElement>('retention-days').value === 'custom';
  element('retention-days-custom-field').hidden = !customDays;
  input('retention-days-custom').required = customDays;
}

function render(settings: PublicSettings) {
  input('prowlarr-url').value = settings.prowlarr.url;
  input('qbittorrent-url').value = settings.qbittorrent.url;
  input('qbittorrent-username').value = settings.qbittorrent.username;
  for (const service of services) {
    const hasSecret = service === 'prowlarr' ? settings.prowlarr.hasApiKey : settings.qbittorrent.hasPassword;
    const select = element<HTMLSelectElement>(`${service}-secret-action`);
    select.options[0]!.textContent = hasSecret ? 'Keep saved credential' : 'Leave unset';
    select.value = 'keep';
    input(`${service}-secret`).value = '';
  }
  element<HTMLSelectElement>('metadata-provider').value = settings.metadata.provider;
  const metaSelect = element<HTMLSelectElement>('metadata-secret-action');
  metaSelect.options[0]!.textContent = settings.metadata.hasTmdbApiKey ? 'Keep saved key' : 'Leave unset';
  metaSelect.value = 'keep';
  input('metadata-secret').value = '';

  const presetDays = [30, 60, 90];
  const daysSelect = element<HTMLSelectElement>('retention-days');
  if (presetDays.includes(settings.retention.days)) {
    daysSelect.value = String(settings.retention.days);
    input('retention-days-custom').value = '';
  } else {
    daysSelect.value = 'custom';
    input('retention-days-custom').value = String(settings.retention.days);
  }
  input('retention-target-ratio').value = String(settings.retention.targetRatio);
  input('retention-grace-days').value = String(settings.retention.graceDays);
  input('retention-extend-on-play').checked = settings.retention.extendOnPlay;
  input('retention-max-cache-gb').value = String(settings.retention.maxCacheGB);

  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="pref-language"]')) {
    el.checked = settings.preferences.languages.includes(el.value);
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="pref-resolution"]')) {
    el.checked = settings.preferences.resolutions.includes(Number(el.value));
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="pref-codec"]')) {
    el.checked = settings.preferences.codecs.includes(el.value);
  }

  baseline = JSON.stringify(draft());
  updateState();
}

async function loadSettings() {
  const result = await api<SettingsResponse>('settings');
  render(result.settings);
  const { manifestUrl: manifest } = await api<{ manifestUrl: string }>('addon');
  input('manifest-url').value = manifest;
  element<HTMLAnchorElement>('install-addon').href = manifest.replace(/^https?:\/\//, 'stremio://');
  element('deployment').textContent = `Port ${result.deployment.port} · Downloads: ${result.deployment.downloadDir}`;
  for (const service of services) message(`${service}-status`, 'Not tested in this session.');
  message('feedback', '');
  message('login-error', '');
  element('login-panel').hidden = true;
  element('workspace').hidden = false;
  element('logout').hidden = false;
  showTab('main');
  void loadDownloads();
}

function setBusy(value: boolean) {
  busy = value;
  for (const id of ['settings-fields-library', 'settings-fields-connections']) {
    element<HTMLFieldSetElement>(id).disabled = value;
  }
  element<HTMLButtonElement>('logout').disabled = value;
  updateState();
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function downloadTags(item: DownloadView): string {
  const kind = item.type === 'series' && item.season !== undefined && item.episode !== undefined
    ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
    : item.type;
  const parts = [kind, formatSize(item.bytes)];
  if (item.progress !== null && item.progress < 1) parts.push(`downloading ${Math.round(item.progress * 100)}%`);
  else if (item.ratio !== null) parts.push(`ratio ${item.ratio.toFixed(2)}`);
  else parts.push('status unknown');
  return parts.join(' · ');
}

function expiryText(item: DownloadView): string {
  if (item.kept) return 'Kept — never expires';
  const daysLeft = Math.ceil((item.expiresAt - Date.now()) / 86_400_000);
  return daysLeft > 0 ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : 'Expiring soon';
}

function downloadRow(item: DownloadView): HTMLElement {
  const row = document.createElement('div');
  row.className = 'download-row';
  row.dataset.hash = item.infoHash;

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

  row.append(main, meta, actions);
  return row;
}

function renderDownloads(list: DownloadView[]) {
  const container = element('downloads-list');
  container.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'help';
    empty.textContent = 'No downloads yet.';
    container.append(empty);
    return;
  }
  for (const item of list) container.append(downloadRow(item));
}

async function loadDownloads() {
  try {
    const result = await api<{ downloads: DownloadView[] }>('downloads');
    renderDownloads(result.downloads);
    message('downloads-feedback', '');
  } catch (error) { message('downloads-feedback', (error as Error).message, 'error'); }
}

async function toggleKeep(hash: string, kept: boolean, button: HTMLButtonElement) {
  button.disabled = true;
  try { await api(`downloads/${hash}`, 'PATCH', { kept }); await loadDownloads(); }
  catch (error) { message('downloads-feedback', (error as Error).message, 'error'); button.disabled = false; }
}

async function deleteDownload(hash: string, button: HTMLButtonElement) {
  if (!confirm('Delete this download from qBittorrent and Debridarr? This removes the downloaded files.')) return;
  button.disabled = true;
  try { await api(`downloads/${hash}`, 'DELETE'); await loadDownloads(); }
  catch (error) { message('downloads-feedback', (error as Error).message, 'error'); button.disabled = false; }
}

element('downloads-refresh').addEventListener('click', () => void loadDownloads());

element('login-form').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    element<HTMLButtonElement>('login-button').disabled = true;
    try {
      const result = await api<{ csrfToken: string }>('login', 'POST', { password: input('admin-password').value });
      csrfToken = result.csrfToken;
      input('admin-password').value = '';
      await loadSettings();
    } catch (error) { message('login-error', (error as Error).message, 'error'); }
    finally { element<HTMLButtonElement>('login-button').disabled = false; }
  })();
});

element('logout').addEventListener('click', () => {
  if (dirty() && !confirm('Discard unsaved changes and sign out?')) return;
  void api('logout', 'POST', {}).then(() => {
    baseline = '';
    for (const service of services) input(`${service}-secret`).value = '';
    showLogin();
  }).catch(error => message('feedback', error.message, 'error'));
});

for (const service of services) {
  for (const field of element(`${service}-url`).closest('section')!.querySelectorAll('input, select')) {
    field.addEventListener('input', () => {
      updateState();
      message(`${service}-status`, 'Settings changed. Test this connection again.');
      message('feedback', '');
    });
  }
  element(`test-${service}`).addEventListener('click', () => {
    const section = element(`${service}-url`).closest('section')!;
    for (const field of section.querySelectorAll<HTMLInputElement>('input')) if (!field.reportValidity()) return;
    void (async () => {
      setBusy(true);
      message(`${service}-status`, 'Testing connection…');
      try {
        const result = await api<{ ok: boolean; message: string; version?: string }>(`test/${service}`, 'POST', draft()[service]);
        message(`${service}-status`, `Last test: ${result.message}${result.version ? ` Version ${result.version}.` : ''}`, result.ok ? 'success' : 'error');
      } catch (error) { message(`${service}-status`, (error as Error).message, 'error'); }
      finally { setBusy(false); }
    })();
  });
}

for (const field of element('metadata-provider').closest('section')!.querySelectorAll('input, select')) {
  field.addEventListener('input', () => { updateState(); message('feedback', ''); });
}
for (const section of document.querySelectorAll('.retention, .preferences')) {
  for (const field of section.querySelectorAll('input, select')) {
    field.addEventListener('input', () => { updateState(); message('feedback', ''); });
  }
}

element('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    setBusy(true);
    message('feedback', 'Saving settings…');
    try {
      const result = await api<{ settings: PublicSettings }>('settings', 'PATCH', draft());
      render(result.settings);
      message('feedback', 'Settings saved. Your changes are active.', 'success');
    } catch (error) { message('feedback', (error as Error).message, 'error'); }
    finally { setBusy(false); }
  })();
});

element('copy-url').addEventListener('click', () => {
  if (!navigator.clipboard) {
    input('manifest-url').select();
    message('copy-status', 'URL selected. Copy it using your keyboard or context menu.');
    return;
  }
  void navigator.clipboard.writeText(input('manifest-url').value)
    .then(() => message('copy-status', 'Addon URL copied.'))
    .catch(() => { input('manifest-url').select(); message('copy-status', 'Select and copy the addon URL.'); });
});
window.addEventListener('beforeunload', event => {
  if (dirty() && !element('workspace').hidden) { event.preventDefault(); event.returnValue = ''; }
});

void (async () => {
  try {
    const session = await api<{ csrfToken: string }>('session');
    csrfToken = session.csrfToken;
    await loadSettings();
  } catch (error) {
    showLogin();
    if ((error as Error).message !== 'Sign in to manage Debridarr') message('login-error', (error as Error).message, 'error');
  } finally { element('loading').hidden = true; }
})();

element('rotate-addon').addEventListener('click', () => {
  if (!confirm('Replace the private installation link? Existing Stremio installations will need the new link.')) return;
  void api<{ manifestUrl: string }>('addon', 'POST', {}).then(({ manifestUrl }) => {
    input('manifest-url').value = manifestUrl;
    element<HTMLAnchorElement>('install-addon').href = manifestUrl.replace(/^https?:\/\//, 'stremio://');
    message('copy-status', 'Link replaced. Reinstall the addon in Stremio.');
  }).catch(error => message('copy-status', error instanceof Error ? error.message : 'Could not replace the link.'));
});
