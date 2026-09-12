import { initDownloadsPanel } from './downloads-panel.js';
import { initDiscoveryPanel } from './discovery-panel.js';
import { element, input, message } from './dom.js';
import { formatPathMappings, parsePathMappings } from './pure.js';
import { initSavedSearchesPanel } from './saved-searches-panel.js';
import { initSetupPanel } from './setup-panel.js';
import { initTokensPanel } from './tokens-panel.js';
import type {
  AdminApi, BackendDescriptor, DiscoveryProviderDescriptor, Draft, PublicSettings, SettingsResponse,
} from './types.js';

let csrfToken = '';
let baseline = '';
let busy = false;
let savedSettings: PublicSettings;
let deployment: SettingsResponse['deployment'];
let availableBackends: BackendDescriptor[] = [];
let availableDiscoveryProviders: DiscoveryProviderDescriptor[] = [];

function selectedBackendLabel(): string {
  return availableBackends.find(candidate => candidate.type === element<HTMLSelectElement>('downloadBackend-type').value)?.label ?? 'download backend';
}

function renderBackendDescriptor(type: string): void {
  const descriptor = availableBackends.find(candidate => candidate.type === type) ?? availableBackends[0];
  if (!descriptor) return;
  for (const id of ['downloadBackend-type', 'setup-downloadBackend-type']) {
    const select = element<HTMLSelectElement>(id);
    select.replaceChildren(...availableBackends.map(candidate => {
      const option = document.createElement('option'); option.value = candidate.type; option.textContent = candidate.label; return option;
    }));
    select.value = descriptor.type;
  }
  element('backend-name').textContent = descriptor.label;
  element('backend-description').textContent = descriptor.description;
  element('setup-backend-title').textContent = `Connect ${descriptor.label}`;
  element('setup-backend-description').textContent = descriptor.description;
  for (const key of ['url', 'username', 'password'] as const) {
    const field = descriptor.fields.find(candidate => candidate.key === key);
    element(`backend-${key}-field`).hidden = !field;
    element(`setup-backend-${key}-field`).hidden = !field;
    const regular = key === 'password' ? input('downloadBackend-secret') : input(`downloadBackend-${key}`);
    const setup = input(`setup-downloadBackend-${key}`);
    if (!field) {
      // A hidden control must not stay required, or setup validation fails
      // for backends that omit username (Deluge's Web UI is password-only).
      setup.required = false;
      continue;
    }
    element(`backend-${key}-label`).textContent = field.label;
    element(`setup-backend-${key}-label`).textContent = `${descriptor.label} ${key === 'url' ? field.label : field.label.toLowerCase()}`;
    regular.placeholder = field.placeholder;
    setup.placeholder = field.placeholder;
    setup.required = !!field.required && (key !== 'password' || savedSettings?.downloadBackend.type !== descriptor.type || !savedSettings.downloadBackend.hasPassword);
  }
  updateModeCopy();
}

const api: AdminApi = async <T>(path: string, method = 'GET', data?: unknown): Promise<T> => {
  const response = await fetch(`/api/admin/${path}`, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  // Not every response on this path comes from Debridarr: a reverse proxy can
  // return an HTML 502/504, and a body limit can return a bare 413. Parsing
  // those as JSON surfaced "Unexpected token '<'" to the operator instead of
  // something they could act on.
  if (response.status === 401) {
    showLogin();
    throw new Error('Your session has expired. Sign in again.');
  }
  const isJson = (response.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
  const result: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
  if (!response.ok) {
    const reported = typeof result === 'object' && result !== null && typeof (result as { error?: unknown }).error === 'string'
      ? (result as { error: string }).error
      : undefined;
    throw new Error(reported ?? statusMessage(response.status));
  }
  if (!isJson || result === undefined) throw new Error(statusMessage(response.status));
  return result as T;
};

function statusMessage(status: number): string {
  if (status === 403) return 'That action was refused. Reload the page and try again.';
  if (status === 413) return 'That request was too large.';
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (status === 502 || status === 503 || status === 504) return `Debridarr did not respond (HTTP ${status}). It may be restarting, or a proxy in front of it returned an error.`;
  return `The request failed (HTTP ${status}). Try again.`;
}

function showLogin() {
  csrfToken = '';
  element('setup-panel').hidden = true;
  input('setup-downloadBackend-password').value = '';
  for (const id of ['discovery-provider-list', 'setup-discovery-provider-list']) {
    for (const secret of element(id).querySelectorAll<HTMLInputElement>('[data-field="apiKey"]')) secret.value = '';
  }
  setupPanel.reset();
  input('store-token-secret').value = '';
  element('store-token-reveal').hidden = true;
  element('store-token-list').replaceChildren();
  element('login-panel').hidden = false;
  element('workspace').hidden = true;
  element('logout').hidden = true;
  input('admin-password').focus();
}

type SettingsTab = 'connections' | 'library' | 'access';
const settingsTabs: SettingsTab[] = ['connections', 'library', 'access'];
function showSettingsTab(tab: SettingsTab, focus = false) {
  for (const name of settingsTabs) {
    const active = name === tab;
    element(`tab-${name}`).hidden = !active;
    const button = element<HTMLButtonElement>(`tab-btn-${name}`);
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  }
}
for (const name of settingsTabs) element(`tab-btn-${name}`).addEventListener('click', () => showSettingsTab(name));
element('settings-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = settingsTabs.findIndex(name => element(`tab-btn-${name}`).getAttribute('aria-selected') === 'true');
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? settingsTabs.length - 1
    : event.key === 'ArrowRight' ? (current + 1) % settingsTabs.length
    : (current - 1 + settingsTabs.length) % settingsTabs.length;
  showSettingsTab(settingsTabs[next]!, true);
});

const settingsDialog = element<HTMLDialogElement>('settings-dialog');
function openSettingsDialog() {
  if (!settingsDialog.open) settingsDialog.showModal();
  showSettingsTab('connections', true);
}
function closeSettingsDialog() {
  if (dirty() && !confirm('Discard unsaved settings changes?')) return;
  if (dirty()) render(savedSettings);
  settingsDialog.close();
}
element('open-settings').addEventListener('click', openSettingsDialog);
element('settings-close').addEventListener('click', closeSettingsDialog);
settingsDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeSettingsDialog();
});
settingsDialog.addEventListener('click', event => {
  if (event.target === settingsDialog) closeSettingsDialog();
});

function draft(): Draft {
  const provider = element<HTMLSelectElement>('metadata-provider').value;
  const daysSelect = element<HTMLSelectElement>('retention-days').value;
  const result: Draft = {
    integrations: { mode: element<HTMLSelectElement>('operating-mode').value },
    store: { maxActiveDownloads: Number(input('store-max-active').value) },
    downloadBackend: {
      type: element<HTMLSelectElement>('downloadBackend-type').value,
      url: input('downloadBackend-url').value,
      username: input('downloadBackend-username').value,
      pathMappings: parsePathMappings(element<HTMLTextAreaElement>('downloadBackend-path-mappings').value),
    },
    discovery: { providers: discoveryPanel.draft() },
    metadata: { provider },
    playback: { streamWhileDownloading: input('playback-stream-while-downloading').checked },
    retention: {
      storeLeaseDays: Number(input('retention-store-days').value),
      days: Number(daysSelect === 'custom' ? input('retention-days-custom').value : daysSelect),
      targetRatio: Number(input('retention-target-ratio').value),
      graceDays: Number(input('retention-grace-days').value),
      extendOnPlay: input('retention-extend-on-play').checked,
      maxCacheGB: Number(input('retention-max-cache-gb').value),
      minFreeSpaceGB: Number(input('retention-min-free-gb').value),
    },
    connections: { webhookUrl: input('webhook-url').value },
    rss: { searches: savedSearchesPanel.draft() },
  };
  const webhookAction = element<HTMLSelectElement>('webhook-secret-action').value;
  if (webhookAction === 'replace') result.connections.webhookSecret = input('webhook-secret').value;
  if (webhookAction === 'clear') result.connections.webhookSecret = null;
  const backendAction = element<HTMLSelectElement>('downloadBackend-secret-action').value;
  if (backendAction === 'replace') result.downloadBackend.password = input('downloadBackend-secret').value;
  if (backendAction === 'clear') result.downloadBackend.password = null;
  if (provider === 'tmdb') {
    const action = element<HTMLSelectElement>('metadata-secret-action').value;
    if (action === 'replace') result.metadata.tmdbApiKey = input('metadata-secret').value;
    if (action === 'clear') result.metadata.tmdbApiKey = null;
  }
  return result;
}

function dirty(): boolean {
  return baseline !== '' && JSON.stringify(draft()) !== baseline;
}

function updateState(): void {
  const changed = dirty();
  element('save-state').textContent = changed ? 'You have unsaved changes' : 'All changes saved';
  element<HTMLButtonElement>('save').disabled = !changed || busy;
  const replace = element<HTMLSelectElement>('downloadBackend-secret-action').value === 'replace';
  input('downloadBackend-secret').disabled = !replace;
  input('downloadBackend-secret').required = replace;
  const tmdb = element<HTMLSelectElement>('metadata-provider').value === 'tmdb';
  element('tmdb-fields').hidden = !tmdb;
  const replaceKey = tmdb && element<HTMLSelectElement>('metadata-secret-action').value === 'replace';
  input('metadata-secret').disabled = !replaceKey;
  input('metadata-secret').required = replaceKey;
  const replaceWebhookSecret = element<HTMLSelectElement>('webhook-secret-action').value === 'replace';
  input('webhook-secret').disabled = !replaceWebhookSecret;
  input('webhook-secret').required = replaceWebhookSecret;
  const customDays = element<HTMLSelectElement>('retention-days').value === 'custom';
  element('retention-days-custom-field').hidden = !customDays;
  input('retention-days-custom').required = customDays;
  for (const row of element('saved-search-list').querySelectorAll<HTMLElement>('.saved-search')) {
    row.querySelector<HTMLButtonElement>('[data-role="poll-button"]')!.disabled = !row.dataset.searchId;
  }
  updateModeCopy();
}

function updateModeCopy(): void {
  const modeEl = document.getElementById('mode-surfaces');
  const noteEl = document.getElementById('backend-protocol-note');
  if (!modeEl || !noteEl) return;
  const mode = element<HTMLSelectElement>('operating-mode').value;
  const searchOn = 'The Stremio search addon is on.';
  const storeOn = 'API tokens, /api/v1, Comet, AIOStreams, and Real-Debrid routes are on.';
  const storeOff = 'API tokens, /api/v1, Comet, AIOStreams, and Real-Debrid routes stay off until you switch to Store or Both.';
  const searchOff = 'Stremio search is off; the library addon still works.';
  modeEl.textContent = mode === 'search' ? `${searchOn} ${storeOff}`
    : mode === 'store' ? `${storeOn} ${searchOff}`
    : `${searchOn} ${storeOn}`;
  const protocol = availableBackends.find(candidate => candidate.type === element<HTMLSelectElement>('downloadBackend-type').value)?.protocol
    ?? savedSettings?.downloadBackend.protocol;
  const usenet = protocol === 'usenet';
  noteEl.hidden = !usenet;
  noteEl.textContent = usenet
    ? 'This client accepts NZBs, not magnets or torrent files. Comet, AIOStreams, and the Real-Debrid adapter will fail until you switch to a torrent client.'
    : '';
}

const discoveryPanel = initDiscoveryPanel({
  api,
  isBusy: () => busy,
  onMainChange: () => { updateState(); message('feedback', ''); },
  onSetupChange: () => { setupPanel.markDirty(); message('setup-feedback', ''); },
});

const savedSearchesPanel = initSavedSearchesPanel({ api, isBusy: () => busy, onChange: updateState });

function setCacheEnabled(on: boolean) {
  element('store-tokens-card').hidden = !on;
  tokensPanel.reset();
  if (on) void tokensPanel.load().catch(error => message('store-token-feedback', (error as Error).message, 'error'));
  element('cache-torrent-card').hidden = !on;
  for (const el of element('cache-torrent-card').querySelectorAll<HTMLInputElement>('input, select, textarea, button')) el.disabled = !on;
  const note = element('cache-feedback');
  if (!on) message('cache-feedback', 'Pick Store or Both mode on the Connections tab to add torrents by hand.');
  else if (note.textContent?.startsWith('Pick Store or Both')) message('cache-feedback', '');
  downloadsPanel.syncCacheForm();
  // The webhook notifies an external system about a transfer this instance
  // manages on its behalf — meaningless in Search-only mode, where Debridarr's
  // own addon is the only consumer.
  element('webhook-card').hidden = !on;
  for (const el of element('webhook-card').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) el.disabled = !on;
  // A saved search adds to the store front door, same as "Cache a torrent" —
  // meaningless while Search mode has no store surface to add into.
  element('rss-card').hidden = !on;
  for (const el of element('rss-card').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) el.disabled = !on;
}

function render(settings: PublicSettings) {
  savedSettings = settings;
  element<HTMLSelectElement>('operating-mode').value = settings.integrations.mode;
  setCacheEnabled(settings.integrations.mode !== 'search');
  input('downloadBackend-url').value = settings.downloadBackend.url;
  input('downloadBackend-username').value = settings.downloadBackend.username;
  element<HTMLSelectElement>('downloadBackend-type').value = settings.downloadBackend.type;
  element<HTMLTextAreaElement>('downloadBackend-path-mappings').value = formatPathMappings(settings.downloadBackend.pathMappings);
  renderBackendDescriptor(settings.downloadBackend.type);
  discoveryPanel.render(settings.discovery.providers);
  {
    const select = element<HTMLSelectElement>('downloadBackend-secret-action');
    select.options[0]!.textContent = settings.downloadBackend.hasPassword ? 'Keep saved credential' : 'Leave unset';
    select.value = 'keep';
    input('downloadBackend-secret').value = '';
  }
  element<HTMLSelectElement>('metadata-provider').value = settings.metadata.provider;
  const metaSelect = element<HTMLSelectElement>('metadata-secret-action');
  metaSelect.options[0]!.textContent = settings.metadata.hasTmdbApiKey ? 'Keep saved key' : 'Leave unset';
  metaSelect.value = 'keep';
  input('metadata-secret').value = '';
  input('webhook-url').value = settings.connections.webhookUrl;
  const webhookSelect = element<HTMLSelectElement>('webhook-secret-action');
  webhookSelect.options[0]!.textContent = settings.connections.hasWebhookSecret ? 'Keep saved secret' : 'Leave unset';
  webhookSelect.value = 'keep';
  input('webhook-secret').value = '';
  savedSearchesPanel.render(settings.rss.searches);
  if (settings.integrations.mode !== 'search') void savedSearchesPanel.loadStatus();

  const presetDays = [30, 60, 90];
  const daysSelect = element<HTMLSelectElement>('retention-days');
  if (presetDays.includes(settings.retention.days)) {
    daysSelect.value = String(settings.retention.days);
    input('retention-days-custom').value = '';
  } else {
    daysSelect.value = 'custom';
    input('retention-days-custom').value = String(settings.retention.days);
  }
  input('retention-store-days').value = String(settings.retention.storeLeaseDays);
  input('store-max-active').value = String(settings.store.maxActiveDownloads);
  input('retention-target-ratio').value = String(settings.retention.targetRatio);
  input('retention-grace-days').value = String(settings.retention.graceDays);
  input('retention-extend-on-play').checked = settings.retention.extendOnPlay;
  input('retention-max-cache-gb').value = String(settings.retention.maxCacheGB);
  input('retention-min-free-gb').value = String(settings.retention.minFreeSpaceGB);
  input('playback-stream-while-downloading').checked = settings.playback.streamWhileDownloading;

  baseline = JSON.stringify(draft());
  updateState();
}

async function loadSettings() {
  const result = await api<SettingsResponse>('settings');
  deployment = result.deployment;
  availableBackends = result.backends;
  availableDiscoveryProviders = result.discoveryProviders;
  discoveryPanel.setDescriptors(result.discoveryProviders);
  render(result.settings);
  const { manifestUrl: manifest } = await api<{ manifestUrl: string }>('addon');
  input('manifest-url').value = manifest;
  element<HTMLAnchorElement>('install-addon').href = manifest.replace(/^https?:\/\//, 'stremio://');
  element('deployment').textContent = `Port ${result.deployment.port} · Downloads: ${result.deployment.downloadDir}`;
  message('downloadBackend-status', 'Not tested in this session.');
  message('feedback', '');
  message('login-error', '');
  element('login-panel').hidden = true;
  element('workspace').hidden = false;
  element('logout').hidden = false;
  if (!result.settings.setup.completed) setupPanel.open();
  else void downloadsPanel.load();
}

function setBusy(value: boolean) {
  busy = value;
  for (const id of ['settings-fields-library', 'settings-fields-connections']) {
    element<HTMLFieldSetElement>(id).disabled = value;
  }
  element<HTMLButtonElement>('logout').disabled = value;
  updateState();
  discoveryPanel.sync();
  savedSearchesPanel.sync();
}

const downloadsPanel = initDownloadsPanel({
  api,
  backendLabel: selectedBackendLabel,
  mode: () => savedSettings.integrations.mode,
  openAccessSettings: () => { openSettingsDialog(); showSettingsTab('access', true); },
});

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
  if ((dirty() || setupPanel.isDirty()) && !confirm('Discard unsaved changes and sign out?')) return;
  void api('logout', 'POST', {}).then(() => {
    baseline = '';
    input('downloadBackend-secret').value = '';
    showLogin();
  }).catch(error => message('feedback', error.message, 'error'));
});

for (const field of element('downloadBackend-url').closest('section')!.querySelectorAll('input, select, textarea')) {
  field.addEventListener('input', () => {
    updateState();
    message('downloadBackend-status', 'Settings changed. Test this connection again.');
    message('feedback', '');
  });
}
element('test-downloadBackend').addEventListener('click', () => {
  const section = element('downloadBackend-url').closest('section')!;
  for (const field of section.querySelectorAll<HTMLInputElement>('input')) if (!field.reportValidity()) return;
  void (async () => {
    setBusy(true);
    message('downloadBackend-status', 'Testing connection…');
    try {
      const result = await api<{ ok: boolean; message: string; version?: string }>('test/downloadBackend', 'POST', draft().downloadBackend);
      message('downloadBackend-status', `Last test: ${result.message}${result.version ? ` Version ${result.version}.` : ''}`, result.ok ? 'success' : 'error');
    } catch (error) { message('downloadBackend-status', (error as Error).message, 'error'); }
    finally { setBusy(false); }
  })();
});
element<HTMLSelectElement>('downloadBackend-type').addEventListener('change', event => renderBackendDescriptor((event.target as HTMLSelectElement).value));

for (const field of element('metadata-provider').closest('section')!.querySelectorAll('input, select')) {
  field.addEventListener('input', () => { updateState(); message('feedback', ''); });
}
for (const field of element('webhook-url').closest('section')!.querySelectorAll('input, select')) {
  field.addEventListener('input', () => { updateState(); message('feedback', ''); });
}
for (const section of document.querySelectorAll('.retention, .playback-settings, .operating-mode')) {
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
  if ((dirty() && !element('workspace').hidden) || (setupPanel.isDirty() && !element('setup-panel').hidden)) { event.preventDefault(); event.returnValue = ''; }
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

const tokensPanel = initTokensPanel(api);

const setupPanel = initSetupPanel({
  api,
  discovery: discoveryPanel,
  settings: () => savedSettings,
  deployment: () => deployment,
  backends: () => availableBackends,
  discoveryLabel: type => availableDiscoveryProviders.find(candidate => candidate.type === type)?.label ?? type,
  renderBackend: renderBackendDescriptor,
  settingsDirty: dirty,
  restoreSettings: () => render(savedSettings),
  settingsSaved: render,
  loadDownloads: downloadsPanel.load,
});
