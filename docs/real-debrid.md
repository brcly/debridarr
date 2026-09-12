# Real-Debrid torrent-compatible surface

Debridarr exposes a **torrent-lifecycle subset** of
[Real-Debrid REST 1.0](https://api.real-debrid.com/) so existing torrent clients
can talk to this instance without a commercial Real-Debrid account. It is a
compatibility adapter over `TransferService`, not a second product. Prefer the
canonical [native API](api-v1.md) for new integrations.

The adapter is available in **Store** and **Both** modes. Search mode returns
404, including for OPTIONS. There is no CORS; this surface is for server
clients. It shares API tokens, scopes, and request quotas with `/api/v1`,
`/store/v1`, and the StremThru adapter.

## Base URL and authentication

Official Real-Debrid uses `https://api.real-debrid.com/rest/1.0/` as the REST
base. Point a client at this Debridarr origin the same way:

```
https://debridarr.example/rest/1.0/
```

A short alias exists for clients that concatenate a store path:

| Real-Debrid path | Short alias |
| --- | --- |
| `GET /rest/1.0/user` | `/store/realdebrid/user` |
| `GET /rest/1.0/torrents` | `/store/realdebrid/torrents` |
| `GET /rest/1.0/torrents/info/{id}` | `/store/realdebrid/torrents/info/{id}` |
| `GET /rest/1.0/torrents/activeCount` | `/store/realdebrid/torrents/activeCount` |
| `GET /rest/1.0/torrents/availableHosts` | `/store/realdebrid/torrents/availableHosts` |
| `POST /rest/1.0/torrents/addMagnet` | `/store/realdebrid/torrents/addMagnet` |
| `PUT /rest/1.0/torrents/addTorrent` | `/store/realdebrid/torrents/addTorrent` |
| `POST /rest/1.0/torrents/selectFiles/{id}` | `/store/realdebrid/torrents/selectFiles/{id}` |
| `DELETE /rest/1.0/torrents/delete/{id}` | `/store/realdebrid/torrents/delete/{id}` |
| `POST /rest/1.0/unrestrict/link` | `/store/realdebrid/unrestrict/link` |

`/store/realdebrid/rest/1.0/...` is accepted for clients that concatenate a base
path onto `/rest/1.0`.

Every call requires `Authorization: Bearer TOKEN` using a Debridarr API token
from Dashboard → **API tokens** (the same 43-character token as `/api/v1`).
OAuth, `/disable_access_token`, and Real-Debrid account login are not
implemented. Clients that cannot send PUT/DELETE may send POST with
`X-HTTP-Verb: PUT` or `X-HTTP-Verb: DELETE`.

| Scope | Grants |
| --- | --- |
| `read` | user, list, info, `activeCount`, `availableHosts` |
| `write` | add magnet/torrent, select files, delete |
| `link` | `unrestrict/link` (mint a signed download URL) |

## Supported workflow

The documented client workflow is:

1. `POST /torrents/addMagnet` or `PUT /torrents/addTorrent` → `{id, uri}` (HTTP 201).
2. `GET /torrents/info/{id}` until `files` is populated.
3. `POST /torrents/selectFiles/{id}` with `files=all` or a comma-separated
   1-based file id list (HTTP 204). Optional: Debridarr already starts a
   playable file on add, so this step is extra selection, not the thing that
   starts the job. During `magnet_conversion`, selectFiles is still 204: it
   retries add so metadata can finish, and is a no-op until the transfer is
   managed.
4. Poll info until `status` is `downloaded` and `links` is non-empty.
5. `POST /unrestrict/link` with each opaque `links[]` value → `download` is a
   signed `${APP_URL}/api/v1/download/<token>` URL with HTTP range support.
6. `DELETE /torrents/delete/{id}` (HTTP 204) removes the transfer and its data.

`test/realdebrid-client.ts` is the pinned REST 1.0 HTTP client used by
`test/realdebrid.test.ts`. It speaks the published schema (form-urlencoded POST,
raw PUT torrent body, `{error, error_code}` errors, 201/204 status codes) against
this adapter. There is no official Real-Debrid JavaScript SDK to pin the way
StremThru is pinned.

### Identifiers

Real-Debrid torrent `id` values are opaque. Debridarr uses the transfer id: a
40-character hex infohash (or the SHA-1 of NZB contents, which this torrent
surface will not create). Clients must use the `id` returned by add, not assume
Real-Debrid's shorter id format.

File ids in `files[]` and `selectFiles` are **1-based integers**, matching
Real-Debrid. They map to Debridarr's 0-based file ids by subtracting one.

### Status mapping

| Debridarr | Real-Debrid `status` |
| --- | --- |
| registering (metadata not ready) | `magnet_conversion` |
| queued | `queued` |
| downloading | `downloading` |
| ready | `downloaded` |
| error | `error` |
| missing | `dead` |

`waiting_files_selection` is **not** advertised. `TransferService.add` already
picks a playable file and starts the download; reporting that status would be a
lie. `selectFiles` remains implemented so clients that always select after add
keep working (HTTP 204, including when the files were already selected).

Progress is an integer 0–100. Dates are JSON (ISO-8601). `host` is the stub
`debridarr.local`. `split` is `0`. `ended`, `speed`, and `seeders` are omitted.

### Links and unrestrict

When `status` is `downloaded`, `links` contains one opaque handle per selected
playable file:

```
https://debridarr.local/d/{id}/{fileId}
```

`fileId` here is Debridarr's 0-based file id. Treat the string as opaque: POST it
to `/unrestrict/link`. That call requires the `link` scope and returns the
Real-Debrid unrestrict object with `download` set to the signed native URL.
`debridarr:{id}:{fileId}` is also accepted. Third-party hoster URLs are rejected
(`error_code` 16). Unrestrict does not fetch caller-supplied URLs.

### Add bodies

`POST /torrents/addMagnet` accepts `application/x-www-form-urlencoded` or JSON
with required `magnet`. A 40-character infohash is accepted as a convenience and
treated as `magnet:?xt=urn:btih:{hash}`. The official `host` field is ignored.

`PUT /torrents/addTorrent` accepts raw torrent bytes (any `Content-Type`), capped
at 2 MiB. Invalid torrent bytes return `error_code` 30.

Re-adding an already-tracked store transfer returns 201 with the same `id`.

### List pagination

`GET /torrents` accepts `offset`, `page`, `limit` (default 100, maximum 5000),
and `filter=active` (anything not `downloaded` / `error` / `dead`). `page` wins
when both `page` and `offset` are sent. The response is a JSON array. Total
matching rows are in `X-Total-Count`.

### Stubs a torrent client may call

These exist so clients that probe them before adding a torrent do not abort.
They are not Real-Debrid account or hoster APIs.

| Request | Response |
| --- | --- |
| `GET /user` | Premium stub: `type` is `"premium"`, `premium` is seconds remaining in a one-year lease, `username` is the token name. No Real-Debrid account is involved. |
| `GET /torrents/availableHosts` | `[{host:"debridarr.local",max_file_size:2147483647}]`. The `host` query on add is ignored. |
| `GET /torrents/activeCount` | `{nb, limit}` where `nb` is non-complete store transfers and `limit` is 1000. |

## Errors

Successful calls return JSON with HTTP 200, except add (201 `{id,uri}`) and
select/delete (204 empty body). Failures use Real-Debrid's envelope:

```json
{"error":"bad_token","error_code":8}
```

| `error_code` | HTTP | Meaning |
| --- | --- | --- |
| 1 | 400 | Missing parameter |
| 2 | 400 | Bad parameter value |
| 3 | 404 | Unknown method / route |
| 4 | 405 | Method not allowed |
| 7 | 404 | Unknown torrent or file id |
| 8 | 401 | Bad token |
| 9 | 403 | Missing scope |
| 16 | 503 | Hoster unlocking is not supported |
| 25 | 503 | Backend unavailable or not configured |
| 26 | 413 | Upload too big |
| 30 | 400 | Torrent file invalid |
| 33 | 409 | Already managed by search / conflict |
| 34 | 429 | Too many requests. Respect `Retry-After`. |
| 37 | 501 | Instant availability is not supported (`/torrents/instantAvailability`). |
| -1 | 5xx | Internal error |

## Explicitly not supported

Do not point a client at Debridarr expecting these Real-Debrid products. They
are different services and are not advertised:

- hoster unlocking of third-party URLs (`/unrestrict/check`, `/unrestrict/folder`,
  container decrypt);
- premium-account traffic and remote CDN (`/traffic`, `/streaming`, `/downloads`);
- instant availability / commercial cache (`/torrents/instantAvailability` answers `501` / `error_code` 37);
- OAuth, `/disable_access_token`, `/hosts`, `/settings`, `/time`;
- NZB / Usenet input on this surface (use `/api/v1` with a Usenet backend).

Cached means present in this instance's store library. There is no shared
commercial debrid cache.
