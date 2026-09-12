import { element, input, message } from './dom.js';
import { formatPathMappings, parsePathMappings } from './pure.js';
import type { AdminApi, BackendDescriptor, PublicSettings, SettingsResponse } from './types.js';

type SetupStep = 'mode' | 'downloadBackend' | 'discovery' | 'retention' | 'review';
interface SetupDiscoveryPanel {
  draft(target: 'setup'): unknown[];
  render(providers: PublicSettings['discovery']['providers'], target: 'setup'): void;
}
interface SetupPanelOptions {
  api: AdminApi;
  discovery: SetupDiscoveryPanel;
  settings: () => PublicSettings;
  deployment: () => SettingsResponse['deployment'];
  backends: () => BackendDescriptor[];
  discoveryLabel: (type: string) => string;
  renderBackend: (type: string) => void;
  settingsDirty: () => boolean;
  restoreSettings: () => void;
  settingsSaved: (settings: PublicSettings) => void;
  loadDownloads: () => Promise<void>;
}

export function initSetupPanel(options: SetupPanelOptions) {
  const state: { step: SetupStep; dirty: boolean; busy: boolean } = { step: 'mode', dirty: false, busy: false };

  function mode(): string {
    return document.querySelector<HTMLInputElement>('input[name="setup-mode"]:checked')!.value;
  }

  function steps(): SetupStep[] {
    return ['mode', 'downloadBackend', ...(mode() === 'store' ? [] : ['discovery' as const]), 'retention', 'review'];
  }

  function discoverySummary(): string {
    const providers = options.settings().discovery.providers;
    return providers.length ? providers.map(provider => `${options.discoveryLabel(provider.type)} (${provider.url})`).join(', ') : 'None configured — add one later in Connections';
  }

  function setBusy(value: boolean): void {
    state.busy = value;
    element<HTMLFieldSetElement>('setup-fields').disabled = value;
    element<HTMLButtonElement>('setup-later').disabled = value;
    element<HTMLButtonElement>('logout').disabled = value;
  }

  function renderStep(focus = true): void {
    for (const step of ['mode', 'downloadBackend', 'discovery', 'retention', 'review']) element(`setup-step-${step}`).hidden = step !== state.step;
    const availableSteps = steps();
    const settings = options.settings();
    const backendName = options.backends().find(candidate => candidate.type === settings.downloadBackend.type)?.label ?? 'Download client';
    const names = { mode: 'Choose mode', downloadBackend: backendName, discovery: 'Discovery', retention: 'Cache policy', review: 'Review' };
    const progress = element('setup-progress'); progress.replaceChildren();
    for (const [index, step] of availableSteps.entries()) {
      const item = document.createElement('li'); item.textContent = `${index + 1}. ${names[step]}`;
      if (step === state.step) item.setAttribute('aria-current', 'step');
      if (index < availableSteps.indexOf(state.step)) item.className = 'done';
      progress.append(item);
    }
    element('setup-back').hidden = state.step === 'mode';
    element('setup-next').textContent = state.step === 'review' ? 'Finish setup' : 'Save and continue';
    if (state.step === 'review') {
      const summary = element('setup-summary'); summary.replaceChildren();
      const currentMode = settings.integrations.mode;
      const rows = [
        ['Mode', { search: 'Search', store: 'Store', both: 'Both' }[currentMode]!],
        [backendName, settings.downloadBackend.url || 'Not connected'],
        ['Discovery', mode() === 'store' ? 'Not needed in Store mode' : discoverySummary()],
        ['API clients', currentMode === 'search'
          ? 'Search mode: Comet, AIOStreams, and /api/v1 are unavailable. Switch to Store or Both to use them.'
          : 'Store APIs are on. Point Comet or AIOStreams at this origin with an API token.'],
        ['Public address', `Open administration at ${options.deployment().appUrl}/configure`],
        ['Retention', `${settings.retention.days} days for search · ${settings.retention.storeLeaseDays} days for store downloads`],
      ];
      for (const [name, value] of rows) {
        const term = document.createElement('dt'); term.textContent = name!;
        const detail = document.createElement('dd'); detail.textContent = value!; summary.append(term, detail);
      }
      element('setup-checks').textContent = 'Check playback readiness now, or finish setup and add a torrent to verify access to a real file.';
      element('setup-download-dir').textContent = options.deployment().downloadDir;
      element('setup-next-help').textContent = mode() === 'search'
        ? 'Next: install your private Stremio addon from the dashboard. Comet and AIOStreams need Store or Both mode. You can adjust retention in Library and per-provider preferences in Connections.'
        : 'Next: add your first torrent or create an API token on the dashboard. Install the Stremio addon to browse your Debridarr Library.';
    }
    if (focus) {
      const heading = element(`setup-step-${state.step}`).querySelector('h2')!; heading.tabIndex = -1; heading.focus();
    }
  }

  function open(): void {
    const settings = options.settings();
    state.step = 'mode'; state.dirty = false;
    input('setup-search-days').value = String(settings.retention.days);
    input('setup-store-days').value = String(settings.retention.storeLeaseDays);
    input('setup-grace-days').value = String(settings.retention.graceDays);
    input('setup-min-free-gb').value = String(settings.retention.minFreeSpaceGB);
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="setup-mode"]')) radio.checked = radio.value === settings.integrations.mode;
    input('setup-downloadBackend-url').value = settings.downloadBackend.url;
    input('setup-downloadBackend-username').value = settings.downloadBackend.username;
    element<HTMLSelectElement>('setup-downloadBackend-type').value = settings.downloadBackend.type;
    element<HTMLTextAreaElement>('setup-downloadBackend-path-mappings').value = formatPathMappings(settings.downloadBackend.pathMappings);
    options.renderBackend(settings.downloadBackend.type);
    options.discovery.render(settings.discovery.providers, 'setup');
    input('setup-downloadBackend-password').value = '';
    input('setup-downloadBackend-password').required = !settings.downloadBackend.hasPassword;
    message('setup-backend-password-help', settings.downloadBackend.hasPassword ? 'A password is saved. Leave blank to keep it.' : 'Use the password for the selected download client.');
    message('setup-downloadBackend-status', ''); message('setup-feedback', '');
    element('workspace').hidden = true; element('setup-panel').hidden = false;
    renderStep(false); element('setup-title').focus();
  }

  function backendDraft(): Record<string, unknown> {
    const patch: Record<string, unknown> = {
      url: input('setup-downloadBackend-url').value.trim(),
      type: element<HTMLSelectElement>('setup-downloadBackend-type').value,
      username: input('setup-downloadBackend-username').value.trim(),
      pathMappings: parsePathMappings(element<HTMLTextAreaElement>('setup-downloadBackend-path-mappings').value),
    };
    if (input('setup-downloadBackend-password').value) patch.password = input('setup-downloadBackend-password').value;
    return patch;
  }

  function validBackend(): boolean {
    return [...element('setup-step-downloadBackend').querySelectorAll<HTMLInputElement>('input')]
      .filter(field => !field.closest('[hidden]')).every(field => field.reportValidity());
  }

  async function testBackend(patch: Record<string, unknown>): Promise<void> {
    message('setup-downloadBackend-status', 'Testing connection...');
    const result = await options.api<{ ok: boolean; message: string }>('test/downloadBackend', 'POST', patch);
    message('setup-downloadBackend-status', result.message, result.ok ? 'success' : 'error');
    if (!result.ok) throw new Error(result.message);
  }

  async function save(patch: unknown): Promise<void> {
    const result = await options.api<{ settings: PublicSettings }>('settings', 'PATCH', patch);
    options.settingsSaved(result.settings); state.dirty = false;
  }

  function exit(): void {
    state.dirty = false; input('setup-downloadBackend-password').value = '';
    element('setup-panel').hidden = true; element('workspace').hidden = false; element('open-setup').focus();
    void options.loadDownloads();
  }

  function reset(): void {
    state.dirty = false;
    input('setup-downloadBackend-password').value = '';
  }

  element('open-setup').addEventListener('click', () => {
    if (options.settingsDirty() && !confirm('Discard unsaved settings and open the setup guide?')) return;
    options.restoreSettings(); open();
  });
  element('setup-later').addEventListener('click', () => {
    if (state.dirty && !confirm('Leave this step without saving your changes? Earlier steps are already saved.')) return;
    exit();
  });
  element('setup-back').addEventListener('click', () => {
    const previous = steps()[steps().indexOf(state.step) - 1]!;
    if (state.dirty) { if (!confirm('Discard unsaved changes on this step and go back?')) return; open(); }
    state.step = previous; message('setup-feedback', ''); renderStep();
  });
  element('setup-skip-discovery').addEventListener('click', () => {
    if (state.dirty && !confirm('Continue without saving these discovery changes?')) return;
    options.discovery.render(options.settings().discovery.providers, 'setup');
    state.dirty = false; state.step = 'retention'; message('setup-feedback', ''); renderStep();
  });
  for (const field of element('setup-form').querySelectorAll('input, select, textarea')) field.addEventListener('input', () => {
    state.dirty = true; message('setup-feedback', '');
    if (state.step === 'mode') renderStep(false);
    else if (state.step === 'downloadBackend') message('setup-downloadBackend-status', '');
  });
  element<HTMLSelectElement>('setup-downloadBackend-type').addEventListener('change', event => options.renderBackend((event.target as HTMLSelectElement).value));
  element('setup-test-downloadBackend').addEventListener('click', () => {
    if (state.busy || !validBackend()) return;
    setBusy(true);
    void testBackend(backendDraft()).catch(error => message('setup-downloadBackend-status', (error as Error).message, 'error')).finally(() => setBusy(false));
  });
  element('setup-form').addEventListener('submit', event => {
    event.preventDefault();
    if (state.busy) return;
    if (state.step === 'retention' && ![...element('setup-step-retention').querySelectorAll<HTMLInputElement>('input')].every(field => field.reportValidity())) return;
    if (state.step === 'downloadBackend' && !validBackend()) return;
    if (state.step === 'discovery' && ![...element('setup-discovery-provider-list').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].every(field => field.reportValidity())) return;
    setBusy(true); message('setup-feedback', 'Saving this step…');
    void (async () => {
      if (state.step === 'review') {
        await save({ setup: { completed: true } }); exit();
        message('feedback', options.settings().integrations.mode === 'search' ? 'Setup complete. Install your Stremio addon below to start watching.' : 'Setup complete. Add your first torrent or install your Stremio addon below.', 'success');
        return;
      }
      if (state.step === 'mode') await save({ integrations: { mode: mode() } });
      else if (state.step === 'retention') await save({ retention: { days: Number(input('setup-search-days').value), storeLeaseDays: Number(input('setup-store-days').value), graceDays: Number(input('setup-grace-days').value), minFreeSpaceGB: Number(input('setup-min-free-gb').value) } });
      else if (state.step === 'discovery') await save({ discovery: { providers: options.discovery.draft('setup') } });
      else {
        const patch = backendDraft(); await testBackend(patch); await save({ downloadBackend: patch });
        input('setup-downloadBackend-password').value = ''; input('setup-downloadBackend-password').required = false;
        message('setup-backend-password-help', 'A password is saved. Leave blank to keep it.');
      }
      state.step = steps()[steps().indexOf(state.step) + 1]!;
      message('setup-feedback', ''); renderStep();
    })().catch(error => message('setup-feedback', (error as Error).message, 'error')).finally(() => setBusy(false));
  });

  return {
    isDirty: () => state.dirty,
    markDirty: () => { state.dirty = true; },
    open,
    reset,
  };
}
