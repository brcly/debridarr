import { element, message } from './dom.js';
import type { AdminApi, PublicSavedSearch, SavedSearchDraft, SavedSearchState } from './types.js';

interface SavedSearchesPanelOptions {
  api: AdminApi;
  isBusy: () => boolean;
  onChange: () => void;
}

export function initSavedSearchesPanel(options: SavedSearchesPanelOptions) {
  const { api, isBusy, onChange } = options;
  const state: { rowSequence: number; statusById: Record<string, SavedSearchState> } = {
    rowSequence: 0,
    statusById: {},
  };

  function rowDraft(row: HTMLElement): SavedSearchDraft {
    const result: SavedSearchDraft = {
      feedUrl: row.querySelector<HTMLInputElement>('[data-field="feedUrl"]')!.value,
      protocol: row.querySelector<HTMLSelectElement>('[data-field="protocol"]')!.value as 'torrent' | 'usenet',
      titleInclude: row.querySelector<HTMLInputElement>('[data-field="titleInclude"]')!.value,
      titleExclude: row.querySelector<HTMLInputElement>('[data-field="titleExclude"]')!.value,
      cachedOnly: row.querySelector<HTMLInputElement>('[data-field="cachedOnly"]')!.checked,
      queue: row.querySelector<HTMLInputElement>('[data-field="queue"]')!.checked,
      enabled: row.querySelector<HTMLInputElement>('[data-field="enabled"]')!.checked,
    };
    if (row.dataset.searchId) result.id = row.dataset.searchId;
    return result;
  }

  function draft(): SavedSearchDraft[] {
    return [...element('saved-search-list').querySelectorAll<HTMLElement>('.saved-search')].map(rowDraft);
  }

  function renderStatus(row: HTMLElement, searchId: string): void {
    const current = state.statusById[searchId];
    const status = row.querySelector<HTMLElement>('[data-role="rss-status"]')!;
    const items = row.querySelector<HTMLElement>('[data-role="rss-items"]')!;
    status.classList.remove('success', 'error');
    if (!current?.lastPolledAt) status.textContent = 'Not polled yet.';
    else {
      const when = new Date(current.lastPolledAt).toLocaleString();
      status.textContent = current.lastError ? `Last poll ${when}: ${current.lastError}` : `Last poll ${when}: OK`;
      status.classList.add(current.lastError ? 'error' : 'success');
    }
    items.replaceChildren();
    for (const item of current?.items.slice(0, 10) ?? []) {
      const line = document.createElement('div'); line.className = 'saved-search-item';
      const title = document.createElement('span'); title.className = 'saved-search-item-title'; title.textContent = item.title || item.guid;
      const itemState = document.createElement('span'); itemState.className = `saved-search-item-status${item.status === 'error' ? ' error' : ''}`;
      itemState.textContent = item.status === 'error' ? item.error ?? 'Error' : item.status;
      line.append(title, itemState);
      if (item.status === 'error') {
        const ignore = document.createElement('button'); ignore.type = 'button'; ignore.className = 'quiet'; ignore.textContent = 'Ignore';
        ignore.addEventListener('click', () => {
          ignore.disabled = true;
          void api<{ status: SavedSearchState }>(`rss/${searchId}/ignore`, 'POST', { guid: item.guid }).then(result => {
            state.statusById[searchId] = result.status; renderStatus(row, searchId);
          }).catch(error => { status.textContent = (error as Error).message; status.classList.add('error'); ignore.disabled = false; });
        });
        line.append(ignore);
      }
      items.append(line);
    }
  }

  async function loadStatus(): Promise<void> {
    try {
      const result = await api<{ status: Record<string, SavedSearchState> }>('rss/status');
      state.statusById = result.status;
      for (const row of element('saved-search-list').querySelectorAll<HTMLElement>('.saved-search')) {
        if (row.dataset.searchId) renderStatus(row, row.dataset.searchId);
      }
    } catch { /* Live status is best effort; editing settings still works. */ }
  }

  function createRow(search?: PublicSavedSearch): HTMLElement {
    const uid = `saved-search-${++state.rowSequence}`;
    const row = document.createElement('section'); row.className = 'saved-search'; row.dataset.uid = uid;
    if (search) row.dataset.searchId = search.id;

    const heading = document.createElement('div'); heading.className = 'saved-search-heading';
    const headingCopy = document.createElement('div');
    const name = document.createElement('h3'); name.textContent = 'Saved search'; headingCopy.append(name);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Remove search';
    heading.append(headingCopy, remove);

    const fields = document.createElement('div'); fields.className = 'saved-search-fields';
    const urlGroup = document.createElement('div'); urlGroup.className = 'wide';
    const urlLabel = document.createElement('label'); urlLabel.htmlFor = `${uid}-url`; urlLabel.textContent = 'Feed URL';
    const urlInput = document.createElement('input');
    urlInput.id = `${uid}-url`; urlInput.type = 'url'; urlInput.autocomplete = 'off'; urlInput.required = true;
    urlInput.dataset.field = 'feedUrl'; urlInput.value = search?.feedUrl ?? ''; urlInput.placeholder = 'https://indexer.example/rss?t=search&apikey=…';
    urlGroup.append(urlLabel, urlInput);

    const protocolGroup = document.createElement('div');
    const protocolLabel = document.createElement('label'); protocolLabel.htmlFor = `${uid}-protocol`; protocolLabel.textContent = 'Protocol';
    const protocol = document.createElement('select'); protocol.id = `${uid}-protocol`; protocol.dataset.field = 'protocol';
    for (const [value, text] of [['torrent', 'Torrent'], ['usenet', 'Usenet']] as const) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; protocol.append(option);
    }
    protocol.value = search?.protocol ?? 'torrent'; protocolGroup.append(protocolLabel, protocol);

    const includeGroup = document.createElement('div');
    const includeLabel = document.createElement('label'); includeLabel.htmlFor = `${uid}-include`; includeLabel.textContent = 'Title must include';
    const include = document.createElement('input'); include.id = `${uid}-include`; include.type = 'text'; include.autocomplete = 'off';
    include.dataset.field = 'titleInclude'; include.value = search?.titleInclude ?? ''; include.placeholder = 'e.g. x265'; includeGroup.append(includeLabel, include);

    const excludeGroup = document.createElement('div');
    const excludeLabel = document.createElement('label'); excludeLabel.htmlFor = `${uid}-exclude`; excludeLabel.textContent = 'Title must not include';
    const exclude = document.createElement('input'); exclude.id = `${uid}-exclude`; exclude.type = 'text'; exclude.autocomplete = 'off';
    exclude.dataset.field = 'titleExclude'; exclude.value = search?.titleExclude ?? ''; exclude.placeholder = 'e.g. CAM'; excludeGroup.append(excludeLabel, exclude);

    const flags = document.createElement('div'); flags.className = 'wide checkbox-group checkbox-group-compact';
    for (const [field, text, checked] of [
      ['enabled', 'Enabled', search?.enabled ?? true],
      ['cachedOnly', 'Cached only — skip anything not already in your library', search?.cachedOnly ?? false],
      ['queue', 'Queue instead of rejecting when at the active download cap', search?.queue ?? false],
    ] as const) {
      const label = document.createElement('label'); label.className = 'checkbox-row';
      const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.field = field; box.checked = checked;
      const copy = document.createElement('span'); copy.textContent = text; label.append(box, copy); flags.append(label);
    }

    const pollRow = document.createElement('div'); pollRow.className = 'test-row wide';
    const poll = document.createElement('button'); poll.type = 'button'; poll.className = 'secondary'; poll.textContent = 'Poll now'; poll.dataset.role = 'poll-button'; poll.disabled = !search;
    const pollHelp = document.createElement('span'); pollHelp.className = 'test-label'; pollHelp.textContent = search ? 'Uses the saved search' : 'Save this search first';
    pollRow.append(poll, pollHelp);
    const status = document.createElement('p'); status.className = 'connection-status wide'; status.dataset.role = 'rss-status'; status.role = 'status'; status.textContent = search ? 'Not polled yet.' : '';
    const items = document.createElement('div'); items.className = 'saved-search-items wide'; items.dataset.role = 'rss-items';
    fields.append(urlGroup, protocolGroup, includeGroup, excludeGroup, flags, pollRow, status, items); row.append(heading, fields);

    const changed = () => { onChange(); message('feedback', ''); };
    for (const field of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) field.addEventListener('input', changed);
    remove.addEventListener('click', () => { row.remove(); sync(); changed(); });
    poll.addEventListener('click', () => {
      const searchId = row.dataset.searchId;
      if (!searchId) return;
      poll.disabled = true; status.textContent = 'Polling…'; status.classList.remove('success', 'error');
      void api<{ status: SavedSearchState }>(`rss/${searchId}/poll`, 'POST', {}).then(result => {
        state.statusById[searchId] = result.status; renderStatus(row, searchId);
      }).catch(error => { status.textContent = (error as Error).message; status.classList.add('error'); })
        .finally(() => { poll.disabled = false; });
    });
    if (search) renderStatus(row, search.id);
    return row;
  }

  function sync(): void {
    const count = element('saved-search-list').querySelectorAll('.saved-search').length;
    element('saved-search-empty').hidden = count > 0;
    element<HTMLButtonElement>('add-saved-search').disabled = isBusy() || count >= 20;
  }

  function render(searches: PublicSavedSearch[]): void {
    element('saved-search-list').replaceChildren(...searches.map(createRow));
    sync();
  }

  element('add-saved-search').addEventListener('click', () => {
    const row = createRow(); element('saved-search-list').append(row); sync(); onChange(); message('feedback', '');
    row.querySelector<HTMLInputElement>('[data-field="feedUrl"]')!.focus();
  });

  return { draft, loadStatus, render, sync };
}
