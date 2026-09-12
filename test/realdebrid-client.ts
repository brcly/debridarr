// Pinned Real-Debrid REST 1.0 HTTP client for adapter tests.
// Speaks the published schema at https://api.real-debrid.com/ (form-urlencoded
// POST, raw PUT torrent body, Bearer auth, {error, error_code} failures,
// 201 add / 204 select-and-delete). There is no official JavaScript SDK.

export class RealDebridError extends Error {
  readonly status: number;
  readonly errorCode: number;
  constructor(status: number, errorCode: number, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export class RealDebridRestClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly prefix: string;
  constructor(origin: string, token: string, prefix = '/rest/1.0') {
    this.origin = origin;
    this.token = token;
    this.prefix = prefix;
  }

  user() { return this.json<RdUser>('GET', '/user'); }
  torrents(query: { offset?: number; page?: number; limit?: number; filter?: 'active' } = {}) {
    const params = new URLSearchParams();
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.filter) params.set('filter', query.filter);
    const suffix = params.size ? `?${params}` : '';
    return this.json<RdTorrentListItem[]>('GET', `/torrents${suffix}`, undefined, true);
  }
  torrentInfo(id: string) { return this.json<RdTorrentInfo>('GET', `/torrents/info/${id}`); }
  activeCount() { return this.json<{ nb: number; limit: number }>('GET', '/torrents/activeCount'); }
  availableHosts() { return this.json<{ host: string; max_file_size: number }[]>('GET', '/torrents/availableHosts'); }
  addMagnet(magnet: string, host?: string) {
    const body = new URLSearchParams({ magnet });
    if (host) body.set('host', host);
    return this.json<{ id: string; uri: string }>('POST', '/torrents/addMagnet', body);
  }
  addTorrent(torrent: Buffer) { return this.json<{ id: string; uri: string }>('PUT', '/torrents/addTorrent', torrent); }
  async selectFiles(id: string, files: string) {
    await this.json<void>('POST', `/torrents/selectFiles/${id}`, new URLSearchParams({ files }));
  }
  async delete(id: string) { await this.json<void>('DELETE', `/torrents/delete/${id}`); }
  unrestrict(link: string) { return this.json<RdUnrestrict>('POST', '/unrestrict/link', new URLSearchParams({ link })); }
  verb(verb: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string) {
    return this.json<unknown>('POST', path, undefined, false, { 'X-HTTP-Verb': verb });
  }

  private async json<T>(
    method: string, path: string, body?: URLSearchParams | Buffer, withCount = false, extra: Record<string, string> = {},
  ): Promise<T & { totalCount?: number }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, ...extra };
    if (body instanceof URLSearchParams) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const init: RequestInit = { method, headers };
    if (body instanceof URLSearchParams) init.body = body;
    else if (body) init.body = new Uint8Array(body);
    const response = await fetch(`${this.origin}${this.prefix}${path}`, init);
    if (response.status === 204) return undefined as unknown as T & { totalCount?: number };
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; }
    catch { parsed = { error: text, error_code: -1 }; }
    if (!response.ok) {
      const error = parsed as { error?: string; error_code?: number };
      throw new RealDebridError(response.status, Number(error.error_code ?? -1), error.error ?? response.statusText);
    }
    const result = parsed as T & { totalCount?: number };
    if (withCount) result.totalCount = Number(response.headers.get('x-total-count') ?? 0);
    return result;
  }
}

export interface RdUser {
  id: number; username: string; email: string; points: number; locale: string; avatar: string;
  type: string; premium: number; expiration: string;
}
export interface RdTorrentListItem {
  id: string; filename: string; hash: string; bytes: number; host: string; split: number;
  progress: number; status: string; added: string; links: string[];
}
export interface RdTorrentInfo extends RdTorrentListItem {
  original_filename: string; original_bytes: number;
  files: { id: number; path: string; bytes: number; selected: number }[];
}
export interface RdUnrestrict {
  id: string; filename: string; mimeType: string; filesize: number; link: string; host: string;
  chunks: number; crc: number; download: string; streamable: number;
}
