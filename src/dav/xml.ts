// Minimal PROPFIND multistatus generation. Real clients (cadaver, Finder,
// Windows, rclone) ask for specific properties or allprop; rather than parse
// the request body and negotiate a property set, this always returns the
// same fixed, broadly-useful set — universally tolerated, since clients read
// whatever properties they need and ignore the rest.
export interface DavEntry {
  // Path segments from the /dav root, not including "dav" itself.
  segments: string[];
  collection: boolean;
  displayName: string;
  bytes?: number;
  contentType?: string;
  lastModified?: Date;
}

const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => XML_ENTITIES[char]!);
}

export function davHref(segments: readonly string[], collection: boolean): string {
  const encoded = segments.map(segment => encodeURIComponent(segment)).join('/');
  return `/dav/${encoded}${collection ? (segments.length ? '/' : '') : ''}`;
}

export function multistatus(entries: readonly DavEntry[]): string {
  const responses = entries.map(entry => {
    const props = [
      `<D:displayname>${escapeXml(entry.displayName)}</D:displayname>`,
      `<D:resourcetype>${entry.collection ? '<D:collection/>' : ''}</D:resourcetype>`,
      entry.collection ? '' : `<D:getcontentlength>${entry.bytes ?? 0}</D:getcontentlength>`,
      entry.contentType ? `<D:getcontenttype>${escapeXml(entry.contentType)}</D:getcontenttype>` : '',
      entry.lastModified ? `<D:getlastmodified>${entry.lastModified.toUTCString()}</D:getlastmodified>` : '',
    ].join('');
    return `<D:response><D:href>${escapeXml(davHref(entry.segments, entry.collection))}</D:href>`
      + `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }).join('');
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}
