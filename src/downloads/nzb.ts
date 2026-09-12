import { createHash } from 'node:crypto';

// NZB is a Newznab XML document. A real file starts with an XML declaration
// or the root <nzb> element; anything else is not a usable Usenet source.
export function isNzb(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<nzb');
}

// Stable transfer id: SHA-1 of the NZB bytes, same 40-hex width as a v1
// infohash so existing download records, coordinators, and API ids work
// without a schema change. It is not a BitTorrent infohash.
export function nzbIdentity(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}
