export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

export const input = (id: string) => element<HTMLInputElement>(id);

export function message(id: string, text: string, kind = ''): void {
  const target = element(id);
  target.textContent = text;
  target.classList.remove('success', 'error');
  if (kind) target.classList.add(kind);
}
