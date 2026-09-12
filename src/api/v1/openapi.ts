// The machine-readable contract for `/api/v1`, served verbatim at
// `GET /api/v1/openapi.json`. It is the single source of truth; `docs/api-v1.md`
// is the prose companion. Keep this in sync when routes change.

const ErrorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: ['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'method_not_allowed', 'conflict', 'payload_too_large', 'unsupported_media_type', 'unprocessable', 'rate_limited', 'bad_gateway', 'unavailable', 'insufficient_storage', 'internal'],
        },
        message: { type: 'string' },
      },
    },
  },
} as const;

const Transfer = {
  type: 'object',
  required: ['id', 'name', 'bytes', 'addedAt', 'expiresAt', 'kept', 'lifecycle'],
  properties: {
    id: { type: 'string', description: 'Stable 40-character id: torrent infohash, or SHA-1 of NZB contents.' },
    name: { type: 'string' },
    bytes: { type: 'integer' },
    addedAt: { type: 'integer', description: 'Unix milliseconds.' },
    expiresAt: { type: 'integer', description: 'Unix milliseconds; retention lease end.' },
    kept: { type: 'boolean' },
    lifecycle: { type: 'string', enum: ['registering', 'managed', 'queued'] },
    media: {
      type: 'object',
      required: ['imdbId', 'type'],
      properties: {
        imdbId: { type: 'string' },
        type: { type: 'string', enum: ['movie', 'series'] },
        season: { type: 'integer' },
        episode: { type: 'integer' },
      },
    },
  },
} as const;

const TransferFile = {
  type: 'object',
  required: ['id', 'path', 'bytes', 'progress', 'video', 'selected'],
  properties: {
    id: { type: 'string' },
    path: { type: 'string' },
    bytes: { type: 'integer' },
    progress: { type: 'number', minimum: 0, maximum: 1 },
    video: { type: 'boolean' },
    selected: { type: 'boolean' },
  },
} as const;

const TransferPreview = {
  type: 'object',
  required: ['id', 'name', 'bytes', 'files'],
  properties: {
    id: { type: 'string', description: 'Stable 40-character id: torrent infohash, or SHA-1 of NZB contents.' },
    name: { type: 'string' },
    bytes: { type: 'integer' },
    seeders: { type: 'integer' },
    files: { type: 'array', items: TransferFile },
  },
} as const;

const TransferStatus = {
  type: 'object',
  required: ['state', 'progress', 'bytes'],
  properties: {
    state: { type: 'string', enum: ['queued', 'downloading', 'ready', 'missing', 'error'] },
    progress: { type: 'number', minimum: 0, maximum: 1 },
    bytes: { type: 'integer' },
  },
} as const;

const Link = {
  type: 'object',
  required: ['url', 'name', 'file', 'expiresAt'],
  properties: {
    url: { type: 'string', format: 'uri', description: 'Signed, expiring GET URL with HTTP range support.' },
    name: { type: 'string' },
    file: TransferFile,
    expiresAt: { type: 'integer', description: 'Unix milliseconds.' },
  },
} as const;

const Release = {
  type: 'object',
  required: ['title', 'size', 'seeders', 'leechers', 'indexer', 'protocol', 'guid'],
  properties: {
    title: { type: 'string' },
    size: { type: 'integer' },
    seeders: { type: 'integer' },
    leechers: { type: 'integer' },
    indexer: { type: 'string' },
    protocol: { type: 'string', enum: ['torrent', 'usenet'] },
    guid: { type: 'string' },
    infoHash: { type: 'string' },
    magnetUrl: { type: 'string' },
    downloadUrl: { type: 'string' },
    publishDate: { type: 'string' },
  },
} as const;

const bearer = [{ bearerAuth: [] }];
const jsonResponse = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const errorResponse = (description: string) => ({ description, ...jsonResponse(ErrorSchema) });
const transferId = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{40}$' } };
const fileId = { name: 'fileId', in: 'path', required: true, schema: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' } };

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Debridarr native API',
    version: '1.0.0',
    description: 'Backend-neutral debrid transfer lifecycle. Bearer tokens carry read/write/link scopes. Available in Store and Both modes only. A Real-Debrid REST 1.0 torrent-compatible adapter is mounted at /rest/1.0 (see docs/real-debrid.md); it is not part of this native document.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: { Error: ErrorSchema, Transfer, TransferFile, TransferPreview, TransferStatus, Link, Release },
    parameters: {
      Cursor: { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from a previous page.' },
      Limit: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,255}$' }, description: 'Durable with the default SQLite state driver; forgotten on restart only under DEBRIDARR_STATE=json.' },
    },
  },
  security: bearer,
  paths: {
    '/openapi.json': {
      get: { summary: 'This document.', security: [], responses: { '200': { description: 'OpenAPI document.', ...jsonResponse({ type: 'object' }) } } },
    },
    '/capabilities': {
      get: {
        summary: 'Token scopes, backend capabilities, and limits.',
        responses: {
          '200': { description: 'Capabilities.', ...jsonResponse({
            type: 'object',
            properties: {
              token: { type: 'object', properties: { id: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'link'] } }, quotas: { type: 'object' } } },
              backend: { type: 'object', properties: { configured: { type: 'boolean' }, input: { type: 'object', properties: { magnet: { type: 'boolean' }, torrent: { type: 'boolean' }, infoHash: { type: 'boolean' }, nzb: { type: 'boolean' } } }, fileSelection: { type: 'boolean' }, freeSpace: { type: 'boolean' }, seedPolicy: { type: 'boolean' }, sequentialDownload: { type: 'boolean' }, verifiedPieces: { type: 'boolean' }, queue: { type: 'boolean' }, cachedOnly: { type: 'boolean' }, pause: { type: 'boolean' }, preview: { type: 'boolean' }, permalink: { type: 'boolean' }, zip: { type: 'boolean' } } },
              limits: { type: 'object' },
            },
          }) },
          '401': errorResponse('Missing or invalid token.'),
          '403': errorResponse('Token lacks the read scope.'),
        },
      },
    },
    '/discover': {
      get: {
        summary: 'Search every configured discovery source (Prowlarr and/or Torznab) for a movie or episode.',
        parameters: [
          { name: 'type', in: 'query', required: true, schema: { type: 'string', enum: ['movie', 'series'] } },
          { name: 'imdbId', in: 'query', required: true, schema: { type: 'string', pattern: '^tt\\d{1,10}$' } },
          { name: 'season', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 9999 }, description: 'Series only: the season.' },
          { name: 'episode', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 9999 }, description: 'Series only: the episode.' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': { description: 'Ranked releases, best first, deduped across sources; empty when no source is configured.', ...jsonResponse({
            type: 'object',
            required: ['releases'],
            properties: { releases: { type: 'array', items: Release } },
          }) },
          '400': errorResponse('Invalid type, imdbId, season, episode, or limit.'),
          '403': errorResponse('Token lacks the read scope.'),
          '502': errorResponse('Metadata or discovery upstream failure.'),
        },
      },
    },
    '/transfers': {
      get: {
        summary: 'List managed transfers, newest first, cursor-paginated.',
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: {
          '200': { description: 'A page of transfers.', ...jsonResponse({
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: { items: { type: 'array', items: Transfer }, next_cursor: { type: ['string', 'null'] } },
          }) },
          '400': errorResponse('Invalid cursor or limit.'),
        },
      },
      post: {
        summary: 'Create a transfer from a magnet, infohash, .torrent, NZB, or provider download URL. Asynchronous and idempotent.',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          content: {
            'application/json': { schema: {
              type: 'object',
              properties: {
                magnet: { type: 'string' },
                infoHash: { type: 'string' },
                torrent: { type: 'string', description: 'base64-encoded .torrent, up to 2 MiB.' },
                nzb: { type: 'string', description: 'base64-encoded NZB, up to 2 MiB. Requires a Usenet download backend.' },
                downloadUrl: { type: 'string', description: 'http(s) NZB or torrent URL from a configured discovery provider.' },
                name: { type: 'string' },
                media: Transfer.properties.media,
                queue: { type: 'boolean', description: 'If the active-download cap is reached, persist as queued instead of 429.' },
                cachedOnly: { type: 'boolean', description: 'Succeed only if this identity is already a managed transfer with a playable file. No backend submit.' },
              },
            } },
            'application/x-bittorrent': { schema: { type: 'string', format: 'binary' } },
            'application/x-nzb': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          '201': { description: 'Registered.', headers: { Location: { schema: { type: 'string' } } }, ...jsonResponse({ type: 'object', properties: { transfer: Transfer } }) },
          '202': { description: 'Accepted; metadata still resolving, or queued until a download slot is free. Poll the transfer.', headers: { Location: { schema: { type: 'string' } }, 'Idempotency-Replay': { schema: { type: 'string' } } }, ...jsonResponse({ type: 'object', properties: { transfer: Transfer } }) },
          '400': errorResponse('Unreadable source.'),
          '403': errorResponse('Token lacks the write scope.'),
          '409': errorResponse('Already managed by search, or deletion in progress.'),
          '413': errorResponse('Torrent body too large.'),
          '415': errorResponse('Unsupported content type.'),
          '429': errorResponse('Quota or admission limit; respect Retry-After.'),
          '503': errorResponse('Backend not configured or unavailable.'),
          '507': errorResponse('Insufficient free space.'),
        },
      },
    },
    '/transfers/status': {
      get: {
        summary: 'Batch availability check.',
        parameters: [{ name: 'ids', in: 'query', required: true, schema: { type: 'string' }, description: 'Repeated or comma-separated infohashes, up to 100.' }],
        responses: {
          '200': { description: 'Status per infohash.', ...jsonResponse({ type: 'object', properties: { statuses: { type: 'object', additionalProperties: TransferStatus } } }) },
          '400': errorResponse('Missing or excessive ids.'),
        },
      },
    },
    '/transfers/preview': {
      post: {
        summary: 'Inspect a magnet, infohash, or torrent file without creating a transfer. Stopped add + files + delete; never persisted.',
        requestBody: {
          content: {
            'application/json': { schema: {
              type: 'object',
              properties: {
                magnet: { type: 'string' },
                infoHash: { type: 'string' },
                torrent: { type: 'string', description: 'base64-encoded .torrent, up to 2 MiB.' },
              },
            } },
            'application/x-bittorrent': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          '200': { description: 'Name, size, files, and seeders when the backend reports them.', ...jsonResponse({ type: 'object', properties: { preview: TransferPreview } }) },
          '400': errorResponse('Unreadable source, or NZB/downloadUrl input.'),
          '403': errorResponse('Token lacks the write scope.'),
          '503': errorResponse('Backend not configured, already present and unowned, or the probe failed. A failed probe leaves no backend job.'),
        },
      },
    },
    '/transfers/{id}': {
      parameters: [transferId],
      get: { summary: 'Inspect one transfer.', responses: { '200': { description: 'The transfer.', ...jsonResponse({ type: 'object', properties: { transfer: Transfer } }) }, '404': errorResponse('No such transfer.') } },
      delete: { summary: 'Remove the transfer and its backend job and data.', responses: { '204': { description: 'Deleted.' }, '403': errorResponse('Token lacks the write scope.'), '404': errorResponse('No such transfer.'), '502': errorResponse('Deletion unconfirmed; still tracked, retry.') } },
    },
    '/transfers/{id}/pause': {
      parameters: [transferId],
      post: { summary: 'Pause the backend job. Queued transfers are not in the backend yet.', responses: { '204': { description: 'Paused.' }, '403': errorResponse('Token lacks the write scope.'), '404': errorResponse('No such transfer.'), '503': errorResponse('Queued, still registering, or unavailable in the backend.') } },
    },
    '/transfers/{id}/resume': {
      parameters: [transferId],
      post: { summary: 'Resume the backend job.', responses: { '204': { description: 'Resumed.' }, '403': errorResponse('Token lacks the write scope.'), '404': errorResponse('No such transfer.'), '503': errorResponse('Queued, still registering, or unavailable in the backend.') } },
    },
    '/transfers/{id}/files': {
      parameters: [transferId],
      get: { summary: 'List files, selected and not.', responses: { '200': { description: 'Files.', ...jsonResponse({ type: 'object', properties: { files: { type: 'array', items: TransferFile } } }) }, '404': errorResponse('No such transfer.'), '503': errorResponse('Transfer not available in the backend.') } },
    },
    '/transfers/{id}/links': {
      parameters: [transferId],
      get: { summary: 'Expiring links for every playable file.', responses: { '200': { description: 'Links.', ...jsonResponse({ type: 'object', properties: { links: { type: 'array', items: Link } } }) }, '403': errorResponse('Token lacks the link scope.'), '404': errorResponse('No such transfer.') } },
    },
    '/transfers/{id}/zip': {
      parameters: [transferId],
      get: {
        summary: 'Stream a zip of the selected (or every complete) playable file. Never buffered in memory.',
        responses: {
          '200': { description: 'A streamed application/zip.', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
          '403': errorResponse('Token lacks the link scope.'),
          '404': errorResponse('No such transfer, or a selected file is gone from the backend.'),
          '409': errorResponse('No complete file to zip yet.'),
        },
      },
    },
    '/transfers/{id}/files/{fileId}/select': {
      parameters: [transferId, fileId],
      post: { summary: 'Select a playable file for download, preserving prior selections.', responses: { '200': { description: 'The selected file.', ...jsonResponse({ type: 'object', properties: { file: TransferFile } }) }, '400': errorResponse('Not a playable file.'), '403': errorResponse('Token lacks the write scope.'), '507': errorResponse('Insufficient free space.') } },
    },
    '/transfers/{id}/files/{fileId}/link': {
      parameters: [transferId, fileId],
      post: { summary: 'Mint an expiring link for one playable file without changing its selection.', responses: { '200': { description: 'The link.', ...jsonResponse({ type: 'object', properties: { link: Link } }) }, '400': errorResponse('Not a playable file.'), '403': errorResponse('Token lacks the link scope.'), '404': errorResponse('No such transfer or file.') } },
    },
    '/transfers/{id}/files/{fileId}/go': {
      parameters: [transferId, fileId],
      get: {
        summary: 'A stable, bookmarkable permalink: redirects to a freshly minted /download link on every visit.',
        parameters: [{ name: 'token', in: 'query', required: false, schema: { type: 'string' }, description: 'The bearer token, for a client that cannot set an Authorization header. Accepted on this route only.' }],
        responses: {
          '302': { description: 'Redirect to a fresh, short-lived /api/v1/download/ URL.', headers: { Location: { schema: { type: 'string' } } } },
          '400': errorResponse('Not a playable file.'),
          '403': errorResponse('Token lacks the link scope.'),
          '404': errorResponse('No such transfer or file.'),
        },
      },
    },
    '/download/{token}': {
      get: {
        summary: 'Stream a file authorized by a signed link. No bearer token; the URL is the capability. Supports HTTP range.',
        security: [],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'The complete file.' },
          '206': { description: 'A requested byte range.' },
          '404': errorResponse('Link expired, malformed, or the file is gone.'),
          '503': errorResponse('Still downloading; a placeholder clip is served instead.'),
        },
      },
    },
  },
} as const;
