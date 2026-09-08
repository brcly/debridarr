# Debridarr handover

Last updated: 2026-09-08

## Objective and current state

Debridarr is a self-hosted Stremio addon using Prowlarr for torrent search,
qBittorrent for downloads, and HTTP range playback of completed files. Prowlarr
and qBittorrent run separately. Indexer coverage depends on the user's Prowlarr
configuration. Streaming incomplete files and absolute anime episode numbering
remain outside the current scope.

The project uses strict TypeScript, Node.js 24, native HTTP and flat JSON storage.
There are no third-party production dependencies. The Docker runtime is Linux,
non-root, and supports a read-only download mount. Run one instance per data
volume; process-local locks and sessions do not support multiple replicas.

The latest work implements the approved audit remediation plan for all eight
findings. No live user services, torrents, or external credentials were changed
while testing. Existing installations need a new private addon URL.

Post-audit fix: the qBittorrent client now accepts address-based auth bypass
(qBittorrent 5.1+ "bypass authentication for clients on localhost / in
whitelisted IP subnets"), where `/api/v2/auth/login` returns `204` with no `SID`
cookie. The connection test previously reported "unexpected response" against
such a setup. See `src/integrations/qbittorrent/client.ts` and
`test/qbittorrent.test.ts`.

## Security audit remediation

| Audited failure | Current behavior | Main code |
| --- | --- | --- |
| Unsigned playback payloads enabled unauthenticated downloads and SSRF | Generated 256-bit installation key; opaque server-side references; constrained Prowlarr proxy requests, public-only pinned redirects and admission limits | `src/security/`, `src/server.ts` |
| Playback tokens exposed Prowlarr API keys | Source details stay in owner-only `addon.json`; links contain random IDs | `src/security/addon.ts`, `src/addon/streams.ts` |
| Symlink escape from DOWNLOAD_DIR | Linux directory-descriptor walk with O_NOFOLLOW; regular-file check; stat and streaming share one descriptor | `src/playback/paths.ts`, `src/playback/serve.ts` |
| Existing unrelated torrents were adopted/mutated | Verify local record, client endpoint, category and unique creation tag; otherwise 409; no global qBittorrent preference writes | `src/downloads/ownership.ts`, `src/downloads/manager.ts` |
| Retention races deleted newly kept/active titles | Shared per-hash coordination, playback reservations, and fresh eligibility checks before deletion | `src/downloads/coordinator.ts`, `src/downloads/deletion.ts` |
| Failed deletes erased tracking | Durable pending deletion; remove records only after a direct successful hash lookup confirms absence | `src/downloads/deletion.ts`, `src/retention/sweeper.ts` |
| Failed preparation left untracked torrents | Persist registration intent before add; startup/hourly reconciliation; verified cleanup for terminal failures | `src/downloads/manager.ts`, `src/retention/sweeper.ts` |
| Concurrent episodes shared the wrong selected file | Serialize registration, select per request, persist the union of selected file indices | `src/downloads/manager.ts`, `src/playback/index.ts` |

## Upgrade requirements

1. Back up and retain the existing data volume (`debridarr-data` in the current
   Compose file). This change does not rename volumes or erase saved settings.
2. Replace any old public addon installation with the private URL from Dashboard
   at `/configure`. Public manifest, stream and playback routes now return 404.
3. If the previous implementation was deployed, rotate its Prowlarr API key in
   Prowlarr and save the new key under Connections. Old encoded links could
   disclose it. Rotation of external credentials is an operator action.
4. Existing download records remain. Legacy ownership requires a matching hash,
   file index/name/size and a `debridarr` or `debridgerr` category on the configured
   client before a new ownership tag is assigned. Unmatched records remain
   visible as conflicts and are excluded from torrent mutation/cleanup.
5. Do not remove tags or change managed torrent categories. Restoring the
   original client/category can resolve a conflict. Never delete downloads.json
   to bypass ownership checks; that would lose tracking.

## Runtime architecture

- `src/index.ts`: loads configuration and three stores, starts HTTP, runs a
  startup/hourly sweep without overlapping sweeps, handles SIGINT/SIGTERM with a
  five-second shutdown deadline. Startup refuses invalid addon storage.
- `src/config.ts`: deployment settings from the environment: PORT, APP_URL,
  required ADMIN_PASSWORD, DATA_DIR and DOWNLOAD_DIR. APP_URL is an HTTP(S)
  origin and pins admin Host/Origin checks.
- `src/settings.ts`: schema 6 integration, metadata, retention and preference
  settings. Old schemas migrate in memory. Environment service credentials seed
  only the first file; later changes use the administration site. Redacted API
  responses and keep/replace/clear credential semantics remain intact.
- `src/storage.ts`: temporary owner-only file, file fsync, atomic rename and
  parent-directory fsync. Writes are serialized by each store. Never silently
  reset corrupt state.
- `src/security/addon.ts`: schema 1 `addon.json` containing a random installation
  key and up to 1,000 release references. References expire after 24 hours, max
  16 KiB each; expired entries are evicted first, then oldest entries. Key and
  references survive restart. Rotation invalidates old keys/references. A source
  fingerprint rejects references after Prowlarr configuration changes, including
  in-flight searches completing with an older settings snapshot.
- `src/security/torrentSource.ts`: allows the configured Prowlarr origin and
  `{urlBase}/{indexerId}/download?link=…`. Discards embedded API keys and sends
  the current X-Api-Key only on the initial request. At most five redirects;
  HTTP(S) targets must resolve exclusively to public addresses. Connections use
  the validated address without a second DNS lookup and preserve Host/TLS name.
  Valid magnet redirects retain trackers. Response body limit: 10 MiB.
- `src/security/admission.ts`: no indefinite request queue. Four searches active,
  thirty searches/minute, two preparations, sixteen playback requests. Manager
  admission also covers sweeper preparations. Ten incomplete managed downloads;
  registration admission across hashes is serialized to enforce this cap.
- `src/admin/`: random 12-hour memory sessions, HttpOnly SameSite=Strict cookies,
  Secure on HTTPS, Host/Origin pinning and CSRF on authenticated writes. Login
  throttling and bounded session/address tables. Administration has no wildcard
  CORS. JSON input limited to 32 KiB.
- `src/metadata/`: Cinemeta or TMDB by IMDb ID, including TMDB alternate/original
  title search. `src/search/` parses titles, matches movie year or episode/pack,
  filters language/resolution/codec allow-sets, deduplicates and ranks. Empty
  allow-sets mean no filter; untagged releases pass. Search deadline: 20 seconds.
- `src/addon/streams.ts`: converts the ranked releases to opaque URLs without
  adding downloads. Logs only fixed failure categories, not raw upstream errors.
- `src/downloads/store.ts`: schema 2 `downloads.json`; accepts schema 1 legacy
  records. Records include lifecycle (`registering`, `managed`, `failed`,
  `deleting`, `conflict`), owner endpoint fingerprint/category/tag, and selected
  files. Registration uses an empty fileName until selection succeeds. Keep and
  leases are retained across migration and preparation.
- `src/downloads/manager.ts`: validate actual source hash, preserve raw .torrent
  bytes when available (even with a supplied hash), acquire the hash coordinator,
  verify ownership or persist intent before adding paused/stopped with a unique
  tag. Verify the resulting torrent before mutations. Disable inherited share
  limits, enable sequential/first-last downloading and select each requested
  file independently. Persist the selection union before updating priorities.
  Start an owned stopped torrent when its selected file still needs downloading.
- `src/playback/`: reserve the torrent before releasing preparation coordination;
  keep the reservation through readiness checks, lease renewal and streaming.
  A not-yet-complete file returns 503 with progress and Retry-After: 15. Completed
  files use one confined descriptor for stat, HEAD and single-range 206/416
  responses. Disconnect/error paths close handles and release reservations.
- `src/retention/sweeper.ts`: query hashes directly; service outages or category
  changes do not mean deletion succeeded. Reconcile interrupted registrations.
  Disable per-torrent automatic removal limits, stop completed owned torrents
  once their ratio target is met, resume if below target. Never write global
  qBittorrent preferences. Per-torrent stop/start uses qBittorrent 5 endpoints or
  pre-5 pause/resume. Delete after lease expiry plus ratio/grace; a soft cache cap
  can override ratio but rechecks Keep, active playback and lease changes.
- `src/downloads/deletion.ts`: reserve deletion under the coordinator and persist
  `deleting` before contacting qBittorrent. New playback/Keep conflict while it
  is pending. Failed requests and unconfirmed absence remain tracked. Startup/
  hourly reconciliation retries pending deletion, including explicit manual
  deletion of a kept title. Legacy or changed-client absence is not sufficient
  to discard an unverified record.
- `web/`: plain TypeScript/HTML/CSS administration site. Dashboard shows private
  install/copy/replace controls and downloads, including lifecycle/failure state.
  Library holds retention/preferences; Connections holds service/metadata
  settings. Tabs share one draft and save bar. DOM content uses textContent.

## HTTP routes

- Public GET/HEAD `/health`; `/` redirects to `/configure`; static configuration
  page and its assets are public, with data/actions behind admin authentication.
- `/addon/{key}/manifest.json`
- `/addon/{key}/stream/{type}/{id}.json`
- `/addon/{key}/play/{reference}`
- `/addon/{key}/configure` redirects to `/configure`.
- Authenticated GET `/api/admin/addon` returns `{manifestUrl}`. POST to the same
  endpoint with JSON `{}` and CSRF rotates the key and returns the new URL.
- Existing login/logout/session/settings/test/downloads admin endpoints remain.

Invalid keys and old public addon routes return 404 without upstream access.
Unknown, expired or wrong-source references require another search. Saturation
returns 429 with Retry-After: 15. An ownership/deletion conflict returns 409.
Manual deletion failures return 502 with a tracking-preserved message. Protected
addon responses support CORS for Stremio. Keep `/addon/` paths out of reverse
proxy access logs because they contain the installation key. Use HTTPS outside
trusted local transport. The manifest remains `org.debridarr.addon`, version 0.1.0.

## Verification

Security regression coverage lives in `test/security.test.ts` and
`test/lifecycle-security.test.ts`, with adapted existing integration tests.
Coverage includes forged legacy tokens, private-key restart/rotation, reference
expiry/cap/invalidation, no credential disclosure in stream responses, proxy
path restrictions, private/reserved/mixed DNS answers and rebinding pinning,
magnet redirects, symlink and inode-replacement attacks, unrelated-torrent
refusal, interrupted adds, failed/unconfirmed deletes, incomplete-download
admission, ownership conflicts, cache Keep/active/lease races, and concurrent
series playback/range responses with distinct file bytes.

Browser coverage exercises settings persistence, credentials, private link
replacement and revoked-link rejection, Keep, failed deletion visibility/retry,
desktop/mobile layout and logout. It uses isolated local mock services and a
fresh temporary store, never user services.

Production Docker smoke checks use a temporary data volume and dummy read-only
video mount: non-root file access, blocked symlink escape, private-key/settings
persistence across container replacement, and clean SIGTERM exit. Test resources
are removed afterward.

Final verification on Node.js **24.20.0**:

- `npm run typecheck`: passed.
- `npm test`: **119 passed**, zero failed/skipped.
- `npm run test:e2e`: production build passed; **1 Playwright flow passed**.
- `npm audit --audit-level=low`: **0 reported vulnerabilities**.
- Production Docker build: passed (`debridarr:security-test`).
- Isolated runtime smoke: passed for read-only confinement, persisted private
  key and settings across container replacement, and graceful shutdown.
- `git diff --check`: passed.

The host defaults to Node 22; final checks used a Node 24 binary extracted from
`node:24-bookworm-slim`, and the production smoke used that Docker image base.
No test containers or temporary data volumes were retained.

## Remaining limits and next work

- Playback still waits for a complete selected file; Stremio may show an error
  while downloading and need a manual retry.
- No live tracker/Prowlarr/qBittorrent/Stremio end-to-end run was performed in
  this security pass. Network protocols are exercised with local fixtures; test
  against an isolated real stack before claiming broad tracker compatibility.
- Only Prowlarr proxy torrent URLs are accepted. A redirect back to a private
  tracker hostname/IP on a local network is deliberately rejected by the public
  redirect policy. Initial configured Prowlarr may be on a private address.
- qBittorrent's API provides no atomic compare-and-delete or exclusive torrent
  add across independent applications. The coordinator serializes Debridarr;
  concurrent external torrent/category/tag edits cannot be locked by this app.
- A registering intent with no visible torrent stays tracked because an add
  reply can be ambiguous. Retry selection or explicitly delete the tracked
  entry after checking qBittorrent. Unverified legacy conflicts need operator
  correction, not automatic adoption.
- Flat-file storage, process-local sessions/coordination, and Linux file access
  are deliberate current constraints. No replication, database, per-user keys,
  partial-file streaming or arbitrary filesystem remapping was added.


## OMV real-environment test preparation

The user has an OMV 8 server at `10.0.0.10` with the OMV Extras Compose plugin.
The existing stack repository is `/home/brcly/workspace/brclys-OMV-compose-files`.
Its arr stack and NGINX Proxy Manager already share the external network
`internal_bridge`. qBittorrent maps `${{ sf:"data" }}/torrents` to
`/data/torrents`; Prowlarr is at `http://gluetun:9696`, qBittorrent at
`http://gluetun:8080`. NGINX Proxy Manager has macvlan address `10.0.0.80` and
also joins `internal_bridge`.

`deploy/omv/` is now tailored to these conventions, with matching files in the
Compose repository's new `debridarr/` directory. The app pulls its published
GHCR image through DEBRIDARR_IMAGE and runs as OMV's `appuser:users` through Docker's user setting,
not PUID/PGID environment variables. Config is a bind mount from
`${{ sf:"appdata" }}/debridarr/config` to `/app/data`; create it owned by
appuser:users with mode 0700 before starting. Downloads mount at the matching
`/data/torrents` path read-only. Both bind mounts require existing directories.
The entry joins its own default network and `internal_bridge`.

The template keeps optional LAN access on `10.0.0.10:7000`. A reverse proxy at
`https://debridarr.nexusvau.lt` should forward to `http://debridarr:7000` through
NGINX Proxy Manager's shared bridge. APP_URL stays on the LAN address until the
proxy is ready, then changes to the HTTPS origin. Credentials are entered in
the configuration site. OMV's shared-folder/user macros remove the need for
GLUETUN_NETWORK and QBT_DOWNLOADS_HOST_PATH environment placeholders.

No remote deployment has been performed. If an earlier named-volume template
was already used, retain that mount or migrate all three JSON files to the
appdata folder before switching. Source archives include current uncommitted
and new security files, not just the last Git commit. Existing files in the
other Compose stacks are untouched.

Tailored OMV verification: both LAN and HTTPS APP_URL configurations pass
`docker compose config` after substituting fixture values for OMV macros.
Assertions cover external bridge membership, matching download mount,
read-only access, config bind location, numeric user/group and required admin
password. A disposable container using UID 12345 / GID 100 successfully created
all private state files, read a torrent owned by a different UID through the
shared group, refused writes to the download mount and served HTTP health.
Test bind directories/containers were removed. Both repositories' YAML and
environment templates match; the source archive was refreshed.


## GitHub Container Registry publishing

The user wants GitHub/GHCR distribution instead of uploading source and building
on OMV. `.github/workflows/container.yml` now runs type checking, unit/integration
tests, Playwright, an AMD64 production build and a startup smoke check on PRs,
main pushes, version tags and manual dispatch. Its separate publish job runs
only after checks pass for main/version tags. It has package-write permission;
checks have only repository read permission. Actions are pinned to verified
upstream commit SHAs and checkout credentials are not persisted.

Publishing detects `ghcr.io/${GITHUB_REPOSITORY,,}` automatically and builds
linux/amd64 plus linux/arm64 with QEMU/Buildx and GitHub Actions build cache.
Main publishes latest/main and a full commit tag; v-prefixed SemVer tags publish
the original tag, normalized version and commit tag without moving latest.
OCI source labels associate the package with its GitHub repository. Authentication
uses GITHUB_TOKEN; operators must make the package public for unauthenticated
pulls or arrange read:packages authentication on OMV for a private package.

The tailored OMV YAML now requires DEBRIDARR_IMAGE and uses pull_policy: always.
Both repository copies and deployment instructions are updated for Pull/Up.
The root Compose file still supports local source builds. The existing origin
points at the user's home Git service; no remote was changed, repository created,
image published or server deployment performed in this task. GitHub owner/name
is used only for the OMV image reference; the workflow itself auto-detects it.

The OMV image default is `ghcr.io/brcly/debridarr:latest`, assuming the new
repository uses the same brcly owner as the existing GitHub Compose repository.
Adjust DEBRIDARR_IMAGE if the user chooses a different repository name.
