# Compatibility support matrix

This is the Stage 7 support matrix: every listed client has a pinned version and
an automated or documented manual check. New integrations should prefer the
canonical [native API](api-v1.md). Compatibility adapters share the same tokens
and quotas.

Retrieved 2026-09-11. Re-read Comet and AIOStreams at `latest` on the next
Debridarr minor (the pins rot). A deployed Comet or AIOStreams stack is not
part of the automated tests; those rows are source-verified against the tagged
release plus HTTP contract tests that speak the same requests.

## Consumer surfaces

| Client | Pinned version | Tested surface | Check | Known gaps |
| --- | --- | --- | --- | --- |
| Stremio addon protocol | [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk) stream / manifest / catalog / meta resources (docs as of 2026-09-11) | `/addon/<key>/manifest.json`, `/stream/{type}/{id}.json`, store-mode `/catalog/other/debridarr-library.json`, `/meta/other/db:{id}.json` | Automated: `test/server.test.ts`, `test/library.test.ts`, `test/play.test.ts`, `test/compatibility.test.ts` | No subtitle resource. No Kitsu / AniList ids (`tt` and `db:` only). `stream.title` is still sent; `stream.description` mirrors it for the SDK deprecation. Search streams are `/play/` URLs, not `infoHash` torrents. |
| StremThru JS SDK | [`stremthru@0.13.0`](https://www.npmjs.com/package/stremthru/v/0.13.0) (upstream [`2ecf43f`](https://github.com/MunifTanjim/stremthru/tree/2ecf43f2d5d4e8e3a06f82a54305d00af7ab345f/sdk/js)) | Magnet Store v0: user, add, check (500-hash batch), get, list, `link/generate`, delete | Automated: `test/store-api.test.ts` | Proxy, Usenet/Torz APIs, StremThru addons, and torrent URL fetching are not implemented. |
| Comet | [`v2.58.0`](https://github.com/g0ldyy/comet/tree/v2.58.0) ([`comet/debrid/stremthru.py`](https://github.com/g0ldyy/comet/blob/v2.58.0/comet/debrid/stremthru.py)) | StremThru debrid client: `X-StremThru-Store-Authorization`, extra `client_ip`/`sid` query, `/user` premium stub, 500-hash `magnets/check`, list `limit=500` | Automated: `test/compatibility.test.ts`. Setup: [store-api.md](store-api.md#comet-self-hosted) | Select **StremThru** and enter the raw Debridarr token (Comet prefixes the store name). If a Comet version hides uncached results, cache first through Debridarr. Deployed Comet is not in CI. |
| AIOStreams | [`v2.34.0`](https://github.com/Viren070/AIOStreams/tree/v2.34.0) ([`packages/core/src/debrid/stremthru.ts`](https://github.com/Viren070/AIOStreams/blob/v2.34.0/packages/core/src/debrid/stremthru.ts), depends on `stremthru@^0.11.0`) | StremThru-backed debrid slot: add magnet, file `link`/`index`/`path`, `link/generate` | Automated: `test/compatibility.test.ts` plus the pinned SDK suite. Setup: [store-api.md](store-api.md#aiostreams-self-hosted) | No generic Debridarr service id — use a StremThru-backed slot such as **Real-Debrid** with a Debridarr token (transport label only). `BUILTIN_STREMTHRU_URL` must point at this origin. Wrapping Debridarr's Stremio addon as an AIOStreams source is unsupported (search streams have no `infoHash`). Deployed AIOStreams is not in CI. |
| Real-Debrid REST 1.0 | Published schema at [api.real-debrid.com](https://api.real-debrid.com/) (retrieved 2026-09-11); in-repo client `test/realdebrid-client.ts` | Torrent lifecycle at `/rest/1.0` | Automated: `test/realdebrid.test.ts` | Hoster unlocking, traffic, CDN, instant availability, and OAuth are not implemented. See [real-debrid.md](real-debrid.md). |
| Native `/api/v1` | This Debridarr release (`0.2.0`); OpenAPI 3.1 at `/api/v1/openapi.json` | Transfers, files, links, discover, capabilities | Automated: `test/api-v1.test.ts`, `test/api-v1-discover.test.ts` | Canonical product API. |
| WebDAV (`/dav/`) | [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) subset: `PROPFIND`, `GET`/`HEAD` with `Range`, `OPTIONS` | Read-only tree of completed, selected files | Automated: `test/dav.test.ts`, `test/dav-tree.test.ts`, `test/dav-xml.test.ts` | Read-only: no `PUT`/`DELETE`/`MOVE`/`MKCOL`/`LOCK`. See [webdav.md](webdav.md). |

## Download backends

These are not consumer HTTP clients. The shared lifecycle contract is the pin.

| Backend | Protocol | Automated check | Notes |
| --- | --- | --- | --- |
| qBittorrent | torrent | `test/backend-contract.test.ts`, `test/qbittorrent.test.ts`, `test/clients.test.ts` | Default. Category + tag ownership, piece map, seed limits, sequential download. |
| Transmission | torrent | `test/backend-contract.test.ts`, `test/transmission.test.ts` | Labels `[scope, marker]`. Piece bitfield is version-dependent. |
| Deluge | torrent | `test/backend-contract.test.ts`, `test/deluge.test.ts` | Packed label `{scope}__{marker}`. Password-only. |
| SABnzbd | usenet | `test/backend-contract.test.ts`, `test/sabnzbd.test.ts` | API-key auth, packed category. No torrent capability groups. |

## Stremio addon shapes

Manifest (`GET /addon/<key>/manifest.json`):

- `id` `org.debridarr.addon`, `version` matching `package.json`, `name`, `description`
- Search mode: `resources.stream` for `movie`/`series` with `idPrefixes: ["tt"]`; empty `catalogs`
- Store / Both: also `other` + `db` prefix, a `meta` resource, and catalog `debridarr-library` with `search`/`skip` extras
- `behaviorHints.configurable: true`, `configurationRequired: false`
- CORS `Access-Control-Allow-Origin: *`; OPTIONS 204; GET/HEAD only

Stream (`GET /stream/{type}/{id}.json` → `{streams:[…]}`):

- `name`, `title`, `description` (same text as `title`), `url`, `behaviorHints.notWebReady`, `behaviorHints.bingeGroup`
- Search / IMDb: `url` is `${APP_URL}/addon/<key>/play/<token>` (server-side `PrepareTransferRequest`)
- Store library (`/stream/other/db:{hash}.json`): `url` is a signed `/api/v1/download/<token>`
- Unknown ids return `{streams:[]}`, not an error

Catalog extras: `search` filters by name; `skip` paginates. Other extras are ignored.

## Explicitly not supported

- Public Torrentio (cannot point at an arbitrary debrid URL)
- Installing Debridarr as a selectable provider in public addons or upstream StremThru
- Mixing a Debridarr token into a public AIOStreams instance or an addon preset that calls commercial APIs
- Comet / AIOStreams **as scrapers of** Debridarr's Stremio addon (use the StremThru debrid slot, or install the Debridarr addon directly in Stremio)
