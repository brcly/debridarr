export const HEX40 = /^[a-f0-9]{40}$/i;

export function isHex40(value: string): boolean {
  return HEX40.test(value);
}

export function parseHex40(value: string): string | undefined {
  return HEX40.test(value) ? value.toLowerCase() : undefined;
}

export function libraryId(infoHash: string): string {
  return `db:${infoHash}`;
}

export function parseDbId(id: string): string | undefined {
  const match = /^db:([a-f0-9]{40})$/i.exec(id);
  return match?.[1]?.toLowerCase();
}
