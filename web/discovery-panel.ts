import { element } from './dom.js';
import type {
  AdminApi, DiscoveryProviderDescriptor, DiscoveryProviderDraft, PreferencesSettings, PublicDiscoveryProvider,
} from './types.js';

type Target = 'main' | 'setup';
interface DiscoveryListElements { list: string; empty: string; add: string }
interface DiscoveryPanelOptions {
  api: AdminApi;
  isBusy: () => boolean;
  onMainChange: () => void;
  onSetupChange: () => void;
}

const elementsByTarget: Record<Target, DiscoveryListElements> = {
  main: { list: 'discovery-provider-list', empty: 'discovery-provider-empty', add: 'add-discovery-provider' },
  setup: { list: 'setup-discovery-provider-list', empty: 'setup-discovery-provider-empty', add: 'setup-add-discovery-provider' },
};

export function initDiscoveryPanel(options: DiscoveryPanelOptions) {
  const { api, isBusy, onMainChange, onSetupChange } = options;
  const state: { descriptors: DiscoveryProviderDescriptor[]; rowSequence: number } = { descriptors: [], rowSequence: 0 };
  const onChange = (target: Target) => target === 'main' ? onMainChange() : onSetupChange();

  function preferencesDraft(prefix: string): PreferencesSettings {
    const checked = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map(field => field.value);
    return {
      languages: checked(`${prefix}-language`),
      resolutions: checked(`${prefix}-resolution`).map(Number),
      codecs: checked(`${prefix}-codec`),
    };
  }

  function renderPreferences(preferences: PreferencesSettings, prefix: string): void {
    for (const [field, values] of [['language', preferences.languages], ['resolution', preferences.resolutions], ['codec', preferences.codecs]] as const) {
      for (const box of document.querySelectorAll<HTMLInputElement>(`input[name="${prefix}-${field}"]`)) box.checked = values.map(String).includes(box.value);
    }
  }

  function rowDraft(row: HTMLElement): DiscoveryProviderDraft {
    const result: DiscoveryProviderDraft = {
      type: row.querySelector<HTMLSelectElement>('[data-field="type"]')!.value,
      url: row.querySelector<HTMLInputElement>('[data-field="url"]')!.value,
      preferences: preferencesDraft(`${row.dataset.uid}-pref`),
    };
    if (row.dataset.providerId) result.id = row.dataset.providerId;
    const action = row.querySelector<HTMLSelectElement>('[data-field="secret-action"]')!.value;
    if (action === 'replace') result.apiKey = row.querySelector<HTMLInputElement>('[data-field="apiKey"]')!.value;
    if (action === 'clear') result.apiKey = null;
    return result;
  }

  function draft(target: Target = 'main'): DiscoveryProviderDraft[] {
    return [...element(elementsByTarget[target].list).querySelectorAll<HTMLElement>('.discovery-provider')].map(rowDraft);
  }

  function sync(target: Target = 'main'): void {
    const ids = elementsByTarget[target];
    const count = element(ids.list).querySelectorAll('.discovery-provider').length;
    element(ids.empty).hidden = count > 0;
    element<HTMLButtonElement>(ids.add).disabled = isBusy() || count >= 10;
  }

  function syncRow(row: HTMLElement, typeChanged = false): void {
    const type = row.querySelector<HTMLSelectElement>('[data-field="type"]')!.value;
    const descriptor = state.descriptors.find(candidate => candidate.type === type)!;
    const urlField = descriptor.fields.find(field => field.key === 'url')!;
    const keyField = descriptor.fields.find(field => field.key === 'apiKey')!;
    row.querySelector<HTMLElement>('[data-role="name"]')!.textContent = descriptor.label;
    row.querySelector<HTMLElement>('[data-role="description"]')!.textContent = descriptor.description;
    const url = row.querySelector<HTMLInputElement>('[data-field="url"]')!;
    row.querySelector<HTMLLabelElement>('[data-role="url-label"]')!.textContent = urlField.label;
    url.placeholder = urlField.placeholder; url.required = !!urlField.required;
    const key = row.querySelector<HTMLInputElement>('[data-field="apiKey"]')!;
    row.querySelector<HTMLLabelElement>('[data-role="key-label"]')!.textContent = `New ${keyField.label.toLowerCase()}`;
    key.placeholder = keyField.placeholder;
    if (typeChanged) {
      key.value = '';
      row.querySelector<HTMLSelectElement>('[data-field="secret-action"]')!.value = keyField.required ? 'replace' : 'clear';
    }
    const replace = row.querySelector<HTMLSelectElement>('[data-field="secret-action"]')!.value === 'replace';
    key.disabled = !replace; key.required = replace && !!keyField.required;
  }

  function createRow(target: Target, provider?: PublicDiscoveryProvider): HTMLElement {
    const descriptor = state.descriptors.find(candidate => candidate.type === provider?.type) ?? state.descriptors[0]!;
    const uid = `discovery-provider-${++state.rowSequence}`;
    const row = document.createElement('section'); row.className = 'discovery-provider'; row.dataset.uid = uid;
    if (provider) row.dataset.providerId = provider.id;

    const heading = document.createElement('div'); heading.className = 'discovery-provider-heading';
    const headingCopy = document.createElement('div');
    const name = document.createElement('h3'); name.dataset.role = 'name';
    const description = document.createElement('p'); description.className = 'muted'; description.dataset.role = 'description';
    headingCopy.append(name, description);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Remove provider';
    heading.append(headingCopy, remove);

    const fields = document.createElement('div'); fields.className = 'discovery-provider-fields';
    const typeGroup = document.createElement('div');
    const typeLabel = document.createElement('label'); typeLabel.htmlFor = `${uid}-type`; typeLabel.textContent = 'Provider type';
    const type = document.createElement('select'); type.id = `${uid}-type`; type.dataset.field = 'type';
    type.replaceChildren(...state.descriptors.map(candidate => {
      const option = document.createElement('option'); option.value = candidate.type; option.textContent = candidate.label; return option;
    }));
    type.value = descriptor.type; typeGroup.append(typeLabel, type);

    const urlGroup = document.createElement('div');
    const urlLabel = document.createElement('label'); urlLabel.htmlFor = `${uid}-url`; urlLabel.dataset.role = 'url-label';
    const url = document.createElement('input'); url.id = `${uid}-url`; url.type = 'url'; url.autocomplete = 'off'; url.dataset.field = 'url'; url.value = provider?.url ?? '';
    urlGroup.append(urlLabel, url);

    const actionGroup = document.createElement('div');
    const actionLabel = document.createElement('label'); actionLabel.htmlFor = `${uid}-secret-action`; actionLabel.textContent = 'API key';
    const action = document.createElement('select'); action.id = `${uid}-secret-action`; action.dataset.field = 'secret-action';
    for (const [value, text] of [['keep', provider?.hasApiKey ? 'Keep saved key' : 'Leave unset'], ['replace', 'Set a new key'], ['clear', 'Clear saved key']]) {
      const option = document.createElement('option'); option.value = value!; option.textContent = text!; action.append(option);
    }
    action.value = !provider && descriptor.fields.find(field => field.key === 'apiKey')?.required ? 'replace' : 'keep';
    actionGroup.append(actionLabel, action);

    const keyGroup = document.createElement('div');
    const keyLabel = document.createElement('label'); keyLabel.htmlFor = `${uid}-key`; keyLabel.className = 'secret-label'; keyLabel.dataset.role = 'key-label';
    const key = document.createElement('input'); key.id = `${uid}-key`; key.type = 'password'; key.autocomplete = 'new-password'; key.dataset.field = 'apiKey';
    keyGroup.append(keyLabel, key);
    fields.append(typeGroup, urlGroup, actionGroup, keyGroup);

    const prefs = document.createElement('div'); prefs.className = 'form-section wide';
    const prefsHeading = document.createElement('h3'); prefsHeading.textContent = 'Content preferences';
    const prefsHelp = document.createElement('p'); prefsHelp.className = 'help'; prefsHelp.textContent = 'Narrow what this provider returns. Leave a group empty to include everything.';
    const fragment = element<HTMLTemplateElement>('preference-fields-template').content.cloneNode(true) as DocumentFragment;
    for (const field of fragment.querySelectorAll('input')) field.name = `${uid}-${field.name}`;
    prefs.append(prefsHeading, prefsHelp, ...fragment.children); fields.append(prefs);

    const testRow = document.createElement('div'); testRow.className = 'test-row wide';
    const test = document.createElement('button'); test.type = 'button'; test.className = 'secondary'; test.textContent = 'Test connection';
    const testLabel = document.createElement('span'); testLabel.className = 'test-label'; testLabel.textContent = 'Does not save changes';
    testRow.append(test, testLabel);
    const status = document.createElement('p'); status.className = 'connection-status wide'; status.dataset.role = 'status'; status.role = 'status'; status.textContent = 'Not tested in this session.';
    fields.append(testRow, status); row.append(heading, fields);

    const changed = () => { onChange(target); status.textContent = 'Settings changed. Test this connection again.'; status.classList.remove('success', 'error'); };
    for (const field of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) field.addEventListener('input', changed);
    type.addEventListener('change', () => { syncRow(row, true); changed(); });
    action.addEventListener('change', () => { syncRow(row); changed(); });
    remove.addEventListener('click', () => { row.remove(); sync(target); onChange(target); });
    test.addEventListener('click', () => {
      if (![...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].every(field => field.reportValidity())) return;
      test.disabled = true; status.textContent = 'Testing connection…'; status.classList.remove('success', 'error');
      void api<{ ok: boolean; message: string; version?: string }>('test/discovery', 'POST', rowDraft(row)).then(result => {
        status.textContent = `${result.message}${result.version ? ` Version ${result.version}.` : ''}`; status.classList.add(result.ok ? 'success' : 'error');
      }).catch(error => { status.textContent = (error as Error).message; status.classList.add('error'); })
        .finally(() => { test.disabled = false; });
    });
    syncRow(row);
    return row;
  }

  function render(providers: PublicDiscoveryProvider[], target: Target = 'main'): void {
    const list = element(elementsByTarget[target].list);
    list.replaceChildren(...providers.map(provider => createRow(target, provider)));
    const rows = [...list.querySelectorAll<HTMLElement>('.discovery-provider')];
    rows.forEach((row, index) => renderPreferences(providers[index]?.preferences ?? { languages: [], resolutions: [], codecs: [] }, `${row.dataset.uid}-pref`));
    sync(target);
  }

  function setDescriptors(descriptors: DiscoveryProviderDescriptor[]): void {
    state.descriptors = descriptors;
  }

  for (const target of ['main', 'setup'] as const) {
    element(elementsByTarget[target].add).addEventListener('click', () => {
      if (!state.descriptors.length) return;
      const row = createRow(target); element(elementsByTarget[target].list).append(row); sync(target); onChange(target);
      row.querySelector<HTMLSelectElement>('[data-field="type"]')!.focus();
    });
  }

  return { draft, render, setDescriptors, sync };
}
