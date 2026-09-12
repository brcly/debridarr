# Native API (`/api/v1`)

`/api/v1` is Debridarr's canonical debrid interface: a backend-neutral transfer
lifecycle that does not depend on Stremio, Prowlarr, or metadata configuration.
It is available in **Store** and **Both** modes; in **Search** mode every route
except `/api/v1/openapi.json` returns `404`.

The machine-readable contract is served at **`GET /api/v1/openapi.json`**
(OpenAPI 3.1, no authentication). This page is its prose companion.

## Authentication and scopes

Every route except `openapi.json` and `download/{token}` requires
`Authorization: Bearer <token>`. Tokens are created on Dashboard → **API tokens**
and carry an explicit scope set:

| Scope | Grants |
| --- | --- |
| `read` | list, inspect, batch status, list files |
| `write` | create, select a file, delete, pause, resume, preview |
| `link` | mint expiring playback links |

A token with a missing scope gets `403 forbidden`. Tokens created before this
release, and new tokens with no scope selection, hold all three. Request quotas
(`requestsPerMinute`, `concurrentRequests`) and the per-source auth throttle are
shared across `/api/v1`, `/store/v1`, the StremThru adapter, and the Real-Debrid adapter.

## Resources

Times are Unix milliseconds. Progress is `0`–`1`. A transfer `id` is a stable
40-character hex value: the torrent infohash, or the SHA-1 of NZB contents.

| Request | Response |
| --- | --- |
| `GET /api/v1/openapi.json` | OpenAPI document. No auth. |
| `GET /api/v1/capabilities` | `{token, backend, limits}` — token scopes/quotas, backend capabilities (magnet/torrent/infoHash/nzb input, file selection, free-space reporting, seed policy, sequential download, verified pieces, queue, cachedOnly, pause, preview), and numeric limits. |
| `GET /api/v1/discover?type=&imdbId=&season=&episode=&limit=` | `{releases:[Release]}` — searches every configured discovery source (Prowlarr and/or Torznab) for a movie or episode, ranked best first and deduped across sources. Each source applies its own resolution, codec and language filters, so a release can appear even when another provider would have excluded it. `season`/`episode` are required for series. Empty when no source is configured. |
| `POST /api/v1/transfers` | `201 {transfer}` or `202 {transfer}` when metadata is still resolving. `Location` points at the new resource. |
| `GET /api/v1/transfers?limit=&cursor=` | `{items:[Transfer], next_cursor}` — newest first, `limit` 1–200 (default 50). Pass `next_cursor` back to page; `null` ends the list. |
| `GET /api/v1/transfers/status?ids=H,H` | `{statuses:{H:{state,progress,bytes}}}` — repeated or comma-separated, up to 100. |
| `POST /api/v1/transfers/preview` | `{preview:{id,name,bytes,seeders?,files}}` — magnet, infohash, or torrent file. No durable record. |
| `GET /api/v1/transfers/{id}` | `{transfer}` or `404`. |
| `POST /api/v1/transfers/{id}/pause` | `204` — pauses the backend job. Queued transfers are `503`. |
| `POST /api/v1/transfers/{id}/resume` | `204` — resumes the backend job. |
| `DELETE /api/v1/transfers/{id}` | `204` after confirmed backend + data removal. |
| `GET /api/v1/transfers/{id}/files` | `{files:[{id,path,bytes,progress,video,selected}]}` — includes unselected files. |
| `POST /api/v1/transfers/{id}/files/{fileId}/select` | `{file}` — starts this video, keeping prior selections. Does not renew the lease. |
| `POST /api/v1/transfers/{id}/files/{fileId}/link` | `{link:{url,name,file,expiresAt}}` — does not change selection. |
| `GET /api/v1/transfers/{id}/files/{fileId}/go` | `302` to a fresh `/api/v1/download/` link. A stable, bookmarkable permalink — see below. |
| `GET /api/v1/transfers/{id}/links` | `{links:[Link]}` — one per playable file. |
| `GET /api/v1/transfers/{id}/zip` | Streams an `application/zip` of the selected (or every complete) playable file. Never buffered in memory; incomplete files are excluded. `409` when nothing qualifies yet. |
| `GET /api/v1/download/{token}` | The file, with HTTP range support. No bearer — the signed URL is the capability. Serves a short "still downloading" clip until the selected file completes (unless experimental partial playback is enabled). |

Create accepts JSON with exactly one of `magnet`, `infoHash`, `torrent`
(base64, ≤ 2 MiB), `nzb` (base64, ≤ 2 MiB), or `downloadUrl` (an http(s) NZB or
torrent link from a configured discovery provider), plus optional `name` and
`media:{imdbId,type,season?,episode?}`. Optional `queue: true` persists the
transfer as `lifecycle: "queued"` (HTTP 202) when `maxActiveDownloads` is full,
instead of `429`; a later slot (delete, completion, or a raised cap) admits the
oldest queued item. Optional `cachedOnly: true` succeeds only if that identity
is already a managed transfer with a playable file — no backend submit, `404`
otherwise. Raw `application/x-bittorrent` and `application/x-nzb` bodies are
also accepted. NZB input requires a Usenet download backend; a torrent backend
returns `422`/`bad_source`. Discovery only returns `protocol: "usenet"` releases
when that backend is configured. `GET /api/v1/capabilities` reports
`backend.queue`, `backend.cachedOnly`, `backend.pause`, and `backend.preview`.

`POST /api/v1/transfers/preview` returns name, size, files, and seeders when the
backend reports them. An already-tracked identity is read in place (queued rows
have no files yet). Anything else is a stopped add + files + delete probe that
never writes a download record; a failed probe still removes the backend job.
NZB and `downloadUrl` sources are rejected. Preview does not start downloading
the files — a magnet may be started briefly so metadata can arrive, then paused
and deleted.

### Idempotent creation

Send `Idempotency-Key: <1–255 chars of [A-Za-z0-9._-]>` on `POST /api/v1/transfers`.
A repeat with the same key and token replays the original status and body and
adds `Idempotency-Replay: true`; a failed attempt is not cached. Keys are
persisted by both state drivers, so a restart can replay them. They are not
shared across replicas; Debridarr supports one process per data directory.

### Links and `download`

`link`/`links` return `${APP_URL}/api/v1/download/<token>` where `<token>` is an
HMAC-signed claim (infohash, file, owner marker, expiry). It is verified
statelessly against a per-deployment secret in `DATA_DIR/store.json`, so links
survive restarts; rotating that secret (restore/replace `store.json`) invalidates
every outstanding link. Links expire after 24 hours. Opening one selects the file
on demand and uses the store retention lease.

`/api/v1/download` is the single owned-file playback path: `/store/v1` links,
StremThru `link/generate`, Real-Debrid `/unrestrict/link`, and the Stremio `db:`
library all issue the same signed URLs. Only the discovery-backed search addon
uses a separate server-side reference store (its `/addon/<key>/play/<token>`
handles).

### Permalink (`go`) and `zip`

`go` trades the 24-hour expiry for a path that never changes: bookmark
`.../files/{fileId}/go` anywhere (a media server's library, a note-taking app),
and every visit mints a fresh signed `/download` link and `302`s to it. It
still needs `link` scope, but since a bare hyperlink cannot set an
`Authorization` header, this one route also accepts `?token=<token>` in the
query string — nowhere else does. Prefer the header when the client supports
it; a query token can end up in browser history or a reverse proxy's access
log (Debridarr's own request log only ever records the path, never the query).

`zip` streams every selected file that is fully downloaded — or, if nothing is
explicitly selected, every complete playable file — as a single
`application/zip`, generated on the fly and never buffered in memory. An
incomplete file is silently excluded, not zipped partially; `409` when that
leaves nothing to zip. Entries always carry ZIP64 records, since debrid
libraries routinely exceed the legacy 4 GiB per-file/per-archive limits.

## Real-Debrid compatibility

A torrent-lifecycle subset of [Real-Debrid REST 1.0](https://api.real-debrid.com/)
is mounted at `/rest/1.0` (alias `/store/realdebrid/`) over the same
`TransferService` and tokens. It covers add magnet/torrent, info, file
selection, list, delete, and unrestrict of opaque local links. Hoster unlocking,
premium-account traffic, and remote CDN are not supported. See
[docs/real-debrid.md](real-debrid.md). Consumer clients (Stremio addon, StremThru,
Comet, AIOStreams) are listed with pinned versions in
[docs/compatibility.md](compatibility.md).

## Errors

Body is always `{"error":{"code","message"}}`. Branch on `code`, never on
`message`.

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Unreadable source, bad cursor/limit/ids, malformed `Idempotency-Key`. |
| `unauthorized` | 401 | Missing or invalid token. |
| `forbidden` | 403 | Token lacks the required scope. |
| `not_found` | 404 | Unknown transfer/route/link, or the API is disabled in Search mode. |
| `method_not_allowed` | 405 | Wrong method for the route. |
| `conflict` | 409 | Already managed by search, deletion in progress, or nothing complete to zip yet. |
| `payload_too_large` | 413 | Torrent body over 2 MiB. |
| `unsupported_media_type` | 415 | Create body is neither JSON nor `application/x-bittorrent`. |
| `unprocessable` | 422 | Valid request, but the torrent has no usable file/infohash. |
| `rate_limited` | 429 | Quota or admission limit. Respect `Retry-After`. |
| `bad_gateway` | 502 | Backend or storage failure; retry. |
| `unavailable` | 503 | Backend not configured, metadata not ready, or free space unmeasurable. |
| `insufficient_storage` | 507 | Below the configured minimum free space. |
| `internal` | 500 | Unexpected failure. |

## Example

```sh
export DEBRIDARR_URL='https://debridarr.example'
read -rs -p 'API token: ' TOKEN; export TOKEN
export HASH='0123456789abcdef0123456789abcdef01234567'

curl -H "Authorization: Bearer $TOKEN" "$DEBRIDARR_URL/api/v1/capabilities"

curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"infoHash\":\"$HASH\"}" "$DEBRIDARR_URL/api/v1/transfers"

curl -H "Authorization: Bearer $TOKEN" "$DEBRIDARR_URL/api/v1/transfers/$HASH"
curl -H "Authorization: Bearer $TOKEN" "$DEBRIDARR_URL/api/v1/transfers/$HASH/files"

LINK=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "$DEBRIDARR_URL/api/v1/transfers/$HASH/files/0/link" | jq -r .link.url)
curl -H 'Range: bytes=0-1023' "$LINK" -o head.bin
```
