# Configuration

Local scripts load `.env` when present; existing process environment values take
precedence. Compose forwards deployment settings to the container. Optional service seeds
must be explicitly added to its `environment` section.

### Deployment settings (environment only, fixed at runtime)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7000` | Local listening port or Compose host port (container stays on 7000); integer from 1–65535. |
| `APP_URL` | `http://localhost:${PORT}` | Public origin of the site; HTTP(S), no path, credentials, query, or fragment. Used to pin admin requests and build the manifest URL. |
| `ADMIN_PASSWORD` | — | **Required.** Password for the `/configure` site. No default. |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Absolute path for state files. By default, SQLite (`debridarr.db`); with `DEBRIDARR_STATE=json`, the legacy JSON files (`settings.json`, `downloads.json`, `addon.json`, `store.json`, `jobs.json`, `idempotency.json`). Directory is `0700`; state files are `0600`. One live process may own a data directory. |
| `DEBRIDARR_STATE` | `sqlite` | State driver: `sqlite` (default, recommended) or `json` (legacy). Both persist jobs and idempotency keys. A one-time import runs on first SQLite startup if JSON files exist. |
| `DOWNLOAD_DIR` | `/downloads` | Absolute path where Debridarr sees the download client's complete and incomplete downloads. Mount the download tree here (ideally at the same path the client uses). Linux only; files must be regular files inside it, without symlinks. |
| `TRUSTED_PROXIES` | — | Comma-separated proxy addresses, CIDR ranges, or the shorthands `loopback` / `private`. When a request arrives from one of these peers, `X-Forwarded-For` decides the client identity used for login throttling, store-token rate limits, and playback admission slots. Unset means the TCP source address is always used and the header is ignored. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug`. Request lines (method, redacted path, status, ms) emit at `info`. `/health` and `/health/ready` are omitted. |
| `DEBRIDARR_METADATA_WAIT_MS` | `8000` | How long a playback request waits for a brand-new torrent's metadata before falling back to the "still downloading" placeholder. Raise it on slow trackers or a congested backend; recovery keeps working on it in the background regardless. |
| `DEBRIDARR_BUFFER_WAIT_MS` | `120000` | How long a playback request waits for the piece(s) covering a requested byte range to finish downloading before it gives up. Raise it on slow storage or a slow download client. |

### Integration settings (managed in the website; environment seeds first run only)

| Variable | Purpose |
| --- | --- |
| `DEBRIDARR_MODE` | `search` (default), `store`, or `both`. `search` enables Debridarr's discovery-backed addon; `store` is a debrid backend other addons add torrents to. |
| `PROWLARR_URL` | Prowlarr HTTP(S) base URL, including any URL base path. Seeds a Prowlarr discovery provider on first run. |
| `PROWLARR_API_KEY` | API credential for the seeded Prowlarr provider. |
| `QBITTORRENT_URL` | qBittorrent Web UI/API HTTP(S) base URL. |
| `QBITTORRENT_USERNAME` | qBittorrent login. |
| `QBITTORRENT_PASSWORD` | qBittorrent password. |
| `METADATA_PROVIDER` | `cinemeta` (default) or `tmdb`. |
| `TMDB_API_KEY` | TMDB v3 API key; required only when the provider is `tmdb`. |

These are read **only when settings do not exist**, to seed them.
After that, edit them at `/configure`; later environment changes are ignored.
Leave them blank to configure everything through the website. Blank values count
as unset. Supplied URLs are validated; put credentials in their dedicated fields,
not URL userinfo or query parameters. Credentials are never logged and are never
returned by the API. Saving does not run a connection check — use the Test
buttons.

The Connections tab also holds the optional [completion webhook](webhooks.md)
(HTTPS POST on `managed` / `failed` / `deleted`) and [RSS saved searches](rss.md)
(poll a Torznab or RSS feed every 15 minutes). Both are Store / Both mode only.

The Connections tab can configure up to ten discovery providers. Prowlarr
aggregates its configured indexers; a Torznab provider connects one compatible
indexer directly. Debridarr searches every provider and combines the results.
Each provider has its own optional resolution, codec, and language preferences
— leave a group empty to include everything — so one installation can take
1080p from its torrent indexers and 2160p from a Usenet one. Provider keys stay
masked in the browser and can be kept, replaced, or explicitly cleared.

### State persistence

Debridarr uses SQLite by default (`DEBRIDARR_STATE=sqlite`), storing all state
in a single `debridarr.db` file. This includes settings, downloads, API tokens,
addon references, idempotency keys for `/api/v1` requests, and scheduled jobs
(retention sweep, download recovery, deletion retries). A restart resumes
scheduled jobs at their next due time instead of restarting from scratch.

If you have existing JSON state files from an earlier version, the first SQLite
startup imports them in one atomic transaction and backs up the originals to
`data/backup-<timestamp>/`. The import is idempotent: running it again is a
no-op.

To use the legacy JSON driver (`DEBRIDARR_STATE=json`), set the environment
variable before startup. It remains available for compatibility and testing.
Settings, downloads, tokens, addon references, scheduled jobs, deletion
retries, and API idempotency records are all written atomically to JSON files.
SQLite remains the recommended driver because it keeps the complete state in
one transactionally consistent database and supports automatic migrations.

Use service addresses reachable from inside the Debridarr container. `localhost`
inside it refers to Debridarr itself. Existing containers can be reached over a
shared Docker network by service name, or through reachable host ports.

Mount the download client's downloads into Debridarr (read-only is fine); an
example is in the root `compose.yaml`. The container's non-root user must have
read/traverse permissions. Mount it at the same path the client uses, or set
`DOWNLOAD_DIR` to where it lands in the Debridarr container — Debridarr tries
both. If the client uses a separate incomplete directory, keep it inside the
shared tree and mount the tree at the same absolute path in both containers.
The `.!qB` (qBittorrent) and `.part` (Transmission) incomplete-file suffixes
are supported. Deluge writes in place. SABnzbd uses separate incomplete and
complete folders; keep both inside the shared tree. A configurable prefix remap for stranger layouts is not implemented yet.


## Playback and storage checks

The setup review and dashboard provide Playback readiness. Connection success
only proves qBittorrent's Web API works. The directory check verifies local
read/traverse access; a real file check uses the same confined descriptor path
as playback. A fresh, empty installation reports file access as unverified.
Add a torrent and rerun the check after data arrives. Both complete and incomplete
files must be mounted. Read-only access is sufficient; symlinks are refused.

`retention.minFreeSpaceGB` defaults to 1 GB on new installations. The guard uses
qBittorrent's `free_space_on_disk` value for its default download filesystem.
Below the threshold, new additions and incomplete additional file selections
return 507. If free space cannot be checked, they return 503. Existing selected
files remain playable, and running downloads are not automatically paused.
Custom save paths on other filesystems require separate monitoring. This is a
minimum-headroom check, not a reservation for the full size of every download.

Settings versions 1–9 retain their minimum-space behavior on upgrade: the new
threshold is 0 (disabled) until changed in Library or the setup guide. Settings
versions 1–10 migrate with partial playback disabled. Settings now save as
version 17.

Incomplete selected files play the bundled downloading status clip by default.
Library → Playback has an experimental **Stream files before their download
completes** option. Enabling it makes Debridarr wait for verified torrent pieces
and serve them as they arrive; seeking, slow peers, and some media containers can
still stall or fail. Completed files use normal playback in either mode.

The cache cap is separate: hourly cleanup evicts eligible titles, while Keep
and active playback protect them. Expired titles wait for the target seed ratio
unless a positive grace period has elapsed. A grace period of 0 means no forced
expiry deadline. The dashboard explains which condition is retaining each title.
