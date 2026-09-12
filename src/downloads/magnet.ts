const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value: string): string | undefined {
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of value.toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) return undefined;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return bytes.length === 20 ? Buffer.from(bytes).toString('hex') : undefined;
}

// Extract the 40-hex-char v1 infohash from a magnet URI (hex or base32 btih).
export function magnetInfoHash(magnet: string): string | undefined {
  let params: URLSearchParams;
  try { params = new URL(magnet).searchParams; }
  catch { return undefined; }
  for (const xt of params.getAll('xt')) {
    const match = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
    if (!match) continue;
    const value = match[1]!;
    if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
    if (/^[a-z2-7]{32}$/i.test(value)) return base32ToHex(value);
  }
  return undefined;
}

export function toMagnet(infoHash: string, displayName?: string): string {
  const dn = displayName ? `&dn=${encodeURIComponent(displayName)}` : '';
  return `magnet:?xt=urn:btih:${infoHash}${dn}`;
}
