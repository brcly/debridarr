import { element, input, message } from './dom.js';
import type { AdminApi } from './types.js';

interface StoreToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  scopes: string[];
  quotas: { requestsPerMinute: number; concurrentRequests: number };
}

export function initTokensPanel(api: AdminApi) {
  async function load(): Promise<void> {
    const { tokens } = await api<{ tokens: StoreToken[] }>('store/tokens');
    const list = element('store-token-list');
    list.replaceChildren();
    for (const token of tokens) {
      const row = document.createElement('div'); row.className = 'token-row';
      const description = document.createElement('div'); description.className = 'token-description';
      const name = document.createElement('strong'); name.textContent = token.name;
      const meta = document.createElement('div'); meta.className = 'token-meta';
      for (const text of [
        `Created ${new Date(token.createdAt).toLocaleDateString()}`,
        `Last used: ${token.lastUsedAt === null ? 'never' : new Date(token.lastUsedAt).toLocaleString()}`,
        `Access: ${token.scopes.join(', ')}`,
        `${token.quotas.requestsPerMinute} requests/min · ${token.quotas.concurrentRequests} concurrent`,
      ]) {
        const detail = document.createElement('span'); detail.textContent = text; meta.append(detail);
      }
      description.append(name, meta);
      const revoke = document.createElement('button');
      revoke.type = 'button'; revoke.className = 'secondary'; revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => {
        revoke.disabled = true;
        void api(`store/tokens/${token.id}`, 'DELETE').then(async () => { reset(); await load(); })
          .catch(error => { revoke.disabled = false; message('store-token-feedback', (error as Error).message, 'error'); });
      });
      row.append(description, revoke); list.append(row);
    }
    if (!tokens.length) list.textContent = 'No API tokens yet.';
  }

  function reset(): void {
    input('store-token-secret').value = '';
    element('store-token-reveal').hidden = true;
  }

  element('store-token-create').addEventListener('click', () => {
    const button = element<HTMLButtonElement>('store-token-create');
    const scopes = [...document.querySelectorAll<HTMLInputElement>('input[name="store-token-scope"]:checked')].map(box => box.value);
    if (!scopes.length) { message('store-token-feedback', 'Choose at least one access level.', 'error'); return; }
    button.disabled = true; reset();
    void api<{ token: string }>('store/tokens', 'POST', {
      name: input('store-token-name').value,
      scopes,
      quotas: { requestsPerMinute: Number(input('store-token-rate').value), concurrentRequests: Number(input('store-token-concurrency').value) },
    }).then(async ({ token }) => {
      input('store-token-secret').value = token;
      element('store-token-reveal').hidden = false;
      input('store-token-secret').select();
      input('store-token-name').value = '';
      message('store-token-feedback', 'Token created. Save it before leaving this page.', 'success');
      await load();
    }).catch(error => message('store-token-feedback', (error as Error).message, 'error'))
      .finally(() => { button.disabled = false; });
  });
  element('store-token-dismiss').addEventListener('click', reset);

  return { load, reset };
}
