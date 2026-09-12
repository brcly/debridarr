# Store API and external addon setup

Select **Store** or **Both** on Connections, configure qBittorrent, and create a
named token on Dashboard → **API tokens**. The token is shown once. Set `APP_URL`
to the public origin reachable by your playback devices; API clients may use an
internal address, but generated playback URLs always use `APP_URL`.

**Cached means present in this instance's store library.** There is no shared
commercial debrid cache. Uncached results require a torrent download, potentially
minutes or hours. Addons that hide uncached results may show nothing until the
download completes. Enable their uncached/cache-and-play option when available.
When a client does surface an uncached result and you play it, Debridarr starts
the download and Stremio plays a short "still downloading" clip; open the stream
again once it reports progress.

> New integrations should prefer the canonical [native API](api-v1.md) at
> `/api/v1` (scoped tokens, cursor pagination, idempotent creation, stable error
> codes, OpenAPI). `/store/v1`, the StremThru adapter, and the
> [Real-Debrid torrent adapter](real-debrid.md) remain supported compatibility
> surfaces and share the same tokens and quotas.

## Native REST

All `/store/v1/*` requests require `Authorization: Bearer TOKEN`. There is no
CORS; this API is for server clients. Search mode returns 404, including for
OPTIONS requests. Changing modes takes effect immediately.

| Request | Response |
| --- | --- |
| `POST /store/v1/magnets` | 201 `{item, pending:false}` or 202 `{item, pending:true}` |
| `GET /store/v1/magnets` | `{items:[StoreItem]}` |
| `GET /store/v1/magnets?hash=HASH,HASH` | `{statuses:{HASH:{state,progress,bytes}}}`; repeated `hash` parameters also work, maximum 100 hashes |
| `GET /store/v1/magnets/HASH` | `{item:StoreItem}` |
| `GET /store/v1/magnets/HASH/files` | `{files:[{id,name,bytes,progress,video,selected}]}` |
| `POST /store/v1/magnets/HASH/files/ID/link` | `{url,name,file}` |
| `POST /store/v1/magnets/HASH/files/ID/select` | `{file}`; downloads this video while preserving previous selections |
| `DELETE /store/v1/magnets/HASH` | `{ok:true}` after confirmed deletion, including downloaded data |

A `StoreItem` contains `infoHash`, `name`, `bytes`, `addedAt`, `expiresAt`, `kept`,
`lifecycle`, and optional `media`. Times are Unix milliseconds. Progress is 0–1.
Status is `queued` (accepted, still registering), `downloading`, `ready`,
`missing`, or `error`; upstream failures produce an HTTP error, never a cached
hit. Status snapshots last up to five seconds; simultaneous refreshes share one
qBittorrent request.

JSON adds accept exactly one of `magnet`, `infoHash`, `torrent` (base64), `nzb`
(base64), or `downloadUrl`, plus optional `name` and `media:{imdbId,type,season?,episode?}`.
The admin-style `source` string is accepted too. For series media, supply season
and episode. Alternatively, POST raw `application/x-bittorrent` or
`application/x-nzb` bytes. Torrent and NZB files are capped at 2 MiB. Remote
`downloadUrl` values are fetched through the configured discovery-provider
allowlist (the same SSRF rules as playback). NZB input requires a Usenet
download backend. Magnets keep their trackers; bare hashes rely on the torrent
client's discovery.

```sh
export DEBRIDARR_URL='https://debridarr.example'
# Read the token without putting it in shell history.
read -rs -p 'Store token: ' DEBRIDARR_TOKEN
export DEBRIDARR_TOKEN
export TORRENT_HASH='0123456789abcdef0123456789abcdef01234567'

curl -H "Authorization: Bearer $DEBRIDARR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"infoHash\":\"$TORRENT_HASH\"}" \
  "$DEBRIDARR_URL/store/v1/magnets"

curl -H "Authorization: Bearer $DEBRIDARR_TOKEN" \
  "$DEBRIDARR_URL/store/v1/magnets?hash=$TORRENT_HASH"

curl -H "Authorization: Bearer $DEBRIDARR_TOKEN" \
  "$DEBRIDARR_URL/store/v1/magnets/$TORRENT_HASH/files"

# Replace 0 with the selected file id.
curl -X POST -H "Authorization: Bearer $DEBRIDARR_TOKEN" \
  "$DEBRIDARR_URL/store/v1/magnets/$TORRENT_HASH/files/0/link"

curl -H "Authorization: Bearer $DEBRIDARR_TOKEN" \
  -H 'Content-Type: application/x-bittorrent' --data-binary @release.torrent \
  "$DEBRIDARR_URL/store/v1/magnets"

curl -X DELETE -H "Authorization: Bearer $DEBRIDARR_TOKEN" \
  "$DEBRIDARR_URL/store/v1/magnets/$TORRENT_HASH"
```

File listings include unselected files. Link generation accepts playable videos
without changing their selection and returns a signed
`${APP_URL}/api/v1/download/<token>` URL (see [the native API](api-v1.md)) with
HTTP range support. Requesting a playback URL selects that file on
demand; use the select endpoint to start it beforehand. Previous selections are
preserved, and selecting alone does not renew the retention lease. Pending metadata
is tracked immediately. A separate worker probes up to two items every 15 seconds,
with per-item backoff up to five minutes. Dashboard Retry also retries preparation.
Recovery never re-adds a missing torrent. A 202 does not mean the torrent
is ready to play. Playback URLs show the downloading status clip until the
selected file completes unless experimental partial playback is enabled in the
administration site. Links expire after 24 hours; mint a fresh one when needed.

Errors use `{error:"message"}`: 400 invalid input or non-video file, 401 invalid
token, 404 unknown item/route, 409 ownership or active playback conflict, 413 body
too large, 415 wrong content type, 429 quota/admission limit, 502 upstream/storage
failure, 503 unavailable torrent/configuration/free-space measurement, or 507 insufficient
free space. Respect `Retry-After` on 429.
Deletion errors leave durable tracking so a DELETE can be retried. The store
surface addresses `origin:store` items. Adding a hash already managed by search
returns 409; use its existing addon stream instead.

## StremThru Store compatibility

Contract: StremThru **v0 magnet Store API**, pinned to the official JavaScript SDK
**`stremthru@0.13.0`** and upstream source commit
[`2ecf43f2d5d4e8e3a06f82a54305d00af7ab345f`](https://github.com/MunifTanjim/stremthru/tree/2ecf43f2d5d4e8e3a06f82a54305d00af7ab345f/sdk/js).
`test/store-api.test.ts` runs that exact SDK over HTTP against Debridarr, with a
fake qBittorrent upstream. It covers user, add (magnet and multipart torrent),
check, get, list/pagination, link generation, delete, and SDK error decoding.

The official SDK constructs absolute `/v0/...` paths, discarding any base URL
path. Therefore Debridarr provides `/v0/store/*` and `/v0/health` aliases in addition
to `/store/stremthru/*`. Use the **origin** as the SDK base URL:

```ts
import { StremThru } from 'stremthru';
const client = new StremThru({
  baseUrl: 'https://debridarr.example',
  auth: { store: 'debridarr', token: process.env.DEBRIDARR_TOKEN! },
});
const { data } = await client.store.addMagnet({ magnet: process.env.TORRENT_HASH! });
const item = await client.store.getMagnet(data.id);
// Wait for files to become available if the add is still processing.
const playback = await client.store.generateLink({ link: item.data.files[0]!.link });
```

| StremThru path | Short alias |
| --- | --- |
| `GET /v0/store/user` | `/store/stremthru/user` |
| `POST/GET /v0/store/magnets` | `/store/stremthru/magnets` |
| `GET /v0/store/magnets/check?magnet=HASH,HASH` | `/store/stremthru/magnets/check` |
| `GET/DELETE /v0/store/magnets/HASH` | `/store/stremthru/magnets/HASH` |
| `POST /v0/store/link/generate` | `/store/stremthru/link/generate` |
| `GET /v0/health` | `/store/stremthru/health` |

The `/store/stremthru/v0/store/...` spelling works for clients that concatenate a
base path. Auth accepts either the native Bearer header or
`X-StremThru-Store-Authorization: Bearer TOKEN`. `X-StremThru-Store-Name` is a
compatibility label and does not select a provider; every request uses this local
library. Proxy Basic authentication, StremThru proxy routes, Usenet, Torz APIs,
StremThru's own addons, and torrent URL fetching are not implemented.

Availability batches accept up to 500 magnets, matching the pinned upstream
contract and Comet's batch size. Native REST batches remain capped at 100.

Responses use `{data:...}` or `{error:{code,type,message}}`. Availability checks
report `cached` only for owned, managed torrents whose selected content is
complete. A hash Debridarr is still registering reports `queued`, one that is
downloading reports `downloading`, and an unknown hash reports `unknown`; a
just-added torrent is never reported as `failed`. Get/add/list report
`downloaded` for complete items and `processing` for pending registration.
Availability checks advertise only selected, completed videos. Get/add expose
all playable files, including unselected ones, for episode selection. A completed
item does not mean every unselected file is downloaded.
File links are opaque `debridarr:HASH:ID` handles: submit them to `link/generate`,
which returns the actual signed `${APP_URL}/api/v1/download/<token>` playback URL.
It never fetches caller-supplied URLs.

### AIOStreams (self-hosted)

Pinned to **[AIOStreams v2.34.0](https://github.com/Viren070/AIOStreams/tree/v2.34.0)**
([StremThru debrid client](https://github.com/Viren070/AIOStreams/blob/v2.34.0/packages/core/src/debrid/stremthru.ts),
depends on `stremthru@^0.11.0`). HTTP contract tests live in
`test/compatibility.test.ts`; the official SDK suite is `stremthru@0.13.0`.
See the [support matrix](compatibility.md).

Set `BUILTIN_STREMTHRU_URL=https://debridarr.example` in the AIOStreams deployment
and restart it. Its current torrent service picker has no generic Debridarr entry:
use a StremThru-backed service slot such as **Real-Debrid**, entering a Debridarr
store token in that slot. This is a transport label; no commercial account is
used. Use AIOStreams' built-in torrent sources and enable uncached downloading.
The StremThru Store *addon preset* is a different integration and is unsupported.

This override affects the instance's built-in StremThru-backed services. Use a
dedicated AIOStreams instance/configuration for Debridarr; do not mix commercial
provider credentials into it or pass the Debridarr token to external addon presets
that contact commercial APIs directly. Public AIOStreams instances cannot change
this server setting. This wiring is source-verified; a full deployed AIOStreams
stack is not part of the automated tests.

### Comet (self-hosted)

Pinned to **[Comet v2.58.0](https://github.com/g0ldyy/comet/tree/v2.58.0)**
([StremThru client](https://github.com/g0ldyy/comet/blob/v2.58.0/comet/debrid/stremthru.py)).
`test/compatibility.test.ts` speaks that client's request shape (header-only
auth, `client_ip`/`sid` query, 500-hash availability batch). See the
[support matrix](compatibility.md).

Set `STREMTHRU_URL=https://debridarr.example` and restart Comet. Select its
**StremThru** debrid service and enter the **raw Debridarr token** as the API key
(Comet supplies the service-name prefix itself). The forwarded store-name label
is ignored. Use the resulting Comet installation for your own library. If a Comet
version hides uncached results, cache the item first through Debridarr. This wiring
is source-verified; a deployed Comet stack is not part of the automated tests.

Public Torrentio cannot be pointed at an arbitrary debrid URL. This adapter does
not add Debridarr as a selectable provider to public addons or upstream StremThru.

## Real-Debrid torrent compatibility

A documented subset of [Real-Debrid REST 1.0](https://api.real-debrid.com/) lives
at `/rest/1.0` (alias `/store/realdebrid/`). It covers the torrent lifecycle —
add magnet/torrent, info, select files, list, delete, and unrestrict of opaque
local links — on `TransferService` with the same scoped tokens. Hoster unlocking,
premium-account traffic, and remote CDN are not implemented.

The pinned client is the in-repo REST 1.0 helper `test/realdebrid-client.ts`
(there is no official JavaScript SDK comparable to StremThru). See
[docs/real-debrid.md](real-debrid.md) for the supported workflow, status mapping,
and explicit non-goals.

## Limits, retention and token administration

- Settings schema **10** adds `retention.minFreeSpaceGB`: 1 GB for fresh setups,
  disabled (0) when migrating existing settings. New torrents and incomplete file
  selections are blocked below the minimum; existing selected playback continues.
  This uses qBittorrent’s default download filesystem, not a future-size reservation.

- `store.maxActiveDownloads` (default 20, range 1–1000).
  Search keeps its own 10-incomplete-download limit. Both have separate buckets
  of two simultaneous preparations. Registration counts are serialized and use
  one category snapshot per admission instead of one request per library item.
  Lowering the cap blocks new additions until usage drops; it does not cancel work.
- `retention.storeLeaseDays` defaults to 14 (range 1–3650). Adds, pending
  reconciliation and playback renewal preserve the store policy. Search defaults
  to 30 days. Existing leases are not retroactively shortened when settings change.
  Keep, ratio, grace period and the shared `retention.maxCacheGB` still apply.
  There is no separate store disk cap or idle eviction policy.
- Each token has a `scopes` set drawn from `read` (list/inspect/status/files),
  `write` (add/select/delete) and `link` (mint playback links). A call outside a
  token's scopes returns `403` (`FORBIDDEN` / `forbidden`). Tokens created before
  scopes existed, and new tokens with no explicit `scopes`, hold all three, so
  `/store/v1` and StremThru behaviour is unchanged. Scopes are enforced on
  `/store/v1`, the StremThru adapter, the Real-Debrid adapter, and `/api/v1` alike.
- Each token has `requestsPerMinute` (default 120, range 1–6000) and
  `concurrentRequests` (default 4, range 1–32), shared across every HTTP surface
  (`/store/v1`, the StremThru adapter, the Real-Debrid adapter, and `/api/v1`).
  All authenticated calls consume the rolling minute budget, including invalid
  requests. In-flight slots release on success and failure. Counters reset on
  restart; token definitions and revocations persist. These are API request
  quotas, not bandwidth, per-user storage or playback limits.
- Five invalid credentials from one socket address trigger a 15-minute throttle.
  Forwarded IP headers are ignored; behind a reverse proxy its clients share that
  source throttle. Valid tokens from unthrottled addresses have independent quotas.
- Store and native links are stateless, signed `/api/v1/download` tokens with a
  24-hour lifetime, verified against the secret in `DATA_DIR/store.json`. Only the
  discovery-backed search addon keeps server-side playback references (one
  1000-entry pool in `addon.json`, 24-hour lifetime).
- Tokens are stored as SHA-256 digests in owner-only (`0600`) `DATA_DIR/store.json`,
  with a maximum of 100 tokens. The same file holds the per-deployment secret
  that signs `/api/v1` download links. Last-used times are persisted at most once
  per minute per token. Back up this file with settings/downloads/addon state.
  Schema **1** files migrate to schema **2** on open (every token gains all
  scopes; a link secret is minted) and are rewritten once.
- The session/CSRF-protected admin endpoints are `GET/POST /api/admin/store/tokens`
  and `DELETE /api/admin/store/tokens/ID`. Creation accepts
  `{name,scopes?:["read","write","link"],quotas?:{requestsPerMinute?,concurrentRequests?}}`
  and returns `{token,item}` once. Listing returns
  `{tokens:[{id,name,createdAt,lastUsedAt,scopes,quotas}]}`.
  To change scopes or quotas, create a replacement token and revoke the old one.
- Tokens grant access to one shared library; they are not separate tenants.
  Revocation blocks future API requests. Already-issued playback URLs and active
  requests remain usable; replacing the addon installation link invalidates all
  existing playback references if needed.

Backend use can materially increase disk use and upstream bandwidth. Run one
Debridarr process against a data directory, with the existing shared qBittorrent
mount. Multiple replicas sharing that directory are unsupported.
