# Debridarr

A self-hosted Stremio addon intended to search your Prowlarr indexers, download
selected torrents with qBittorrent, and stream the files back to Stremio.

**Current status: search, download, playback, and retention all work.**
Debridarr has a password-protected configuration site for your Prowlarr,
qBittorrent, and metadata settings; resolves a title (including its
original-language title, when your metadata provider gives one), searches your
indexers, filters and ranks results by resolution/source/seeders and any
resolutions/codecs/languages you've allow-listed (e.g. "only 4K or 1080p,
only x265" — pick as many as you like, not just one), and lists them as
Stremio streams. Picking
one adds the torrent to qBittorrent under a `debridarr` category — including
releases that only give a `.torrent`-file download URL rather than a magnet,
common on private trackers — picks the right file, and streams it back once it
has finished downloading (reporting progress while it's still in progress).
Downloaded titles are cached "debrid-like": a fixed lease (30 days by default),
deleted only once seeded to a target ratio, with a per-title Keep override — an
hourly sweeper enforces this, and the configuration site has a Downloads list
(Keep/Release/Delete, live status) plus Retention and Preferences settings
cards. Prowlarr and qBittorrent are managed separately.

## Run with Docker

Requires Docker Engine and the Docker Compose plugin.

For the OMV 8 home server, use the [tailored OMV setup](deploy/omv/README.md),
which matches the existing shared folders, app user and proxy network.

```sh
cp .env.example .env
# edit .env and set ADMIN_PASSWORD
docker compose up --build -d
curl http://localhost:7000/health
docker compose logs -f debridarr
```

Health returns `{"status":"ok"}`. Open `http://localhost:7000/configure` and sign
in with `ADMIN_PASSWORD` to connect your services. Stop with `docker compose down`.
Configuration is stored in the `debridarr-data` volume and survives container
replacement. For playback, mount qBittorrent's completed-downloads directory into
the container (see `compose.yaml` and `DOWNLOAD_DIR` below); search itself only
needs network access to Prowlarr and the metadata provider.

## Publish images with GitHub Container Registry

`.github/workflows/container.yml` publishes `ghcr.io/<owner>/<repository>` using
the GitHub repository name in lowercase. Push the committed project to `main`
to run type checking, unit/integration tests, Playwright and a production-image
startup check. Publishing only runs after those checks pass; pull requests never
publish. Images support `linux/amd64` and `linux/arm64`.

- `latest` and `main` follow successful main builds.
- `sha-<full-commit>` identifies the source commit used for a build.
- Pushing a SemVer tag such as `v0.1.0` also publishes `v0.1.0` and `0.1.0`.
  Version-tag builds leave `latest` on the main channel.
- Manual workflow dispatch supports main and version tags.

The workflow uses GITHUB_TOKEN with package-write permission and pinned GitHub
Actions versions. No extra publishing secret is needed. After the first image
is published, make the GHCR package public for anonymous pulls, or authenticate
OMV for private pulls. Package visibility is separate from repository visibility;
see [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Set DEBRIDARR_IMAGE in the [OMV environment template](deploy/omv/debridarr.env.example)
to that package's image reference. Updates then use Pull and Up in OMV; the
server does not need the source tree or local image builds. The root Compose
file retains its source-build workflow for local development.

The current Git remote can remain your home Git server. Add GitHub as another
remote if desired, and push the committed project there. Creating the GitHub
repository and the first registry publication are still deployment steps to
complete; the workflow's presence alone does not mean an image exists.

## Configuration website

Visit `/configure` (the root path redirects there) and sign in with the
administrator password. The site has three tabs (no separate URLs — it's one
page, switched with plain JS — but all three share one save bar, so an
unsaved edit on one tab survives a trip to another and back):

**Dashboard** (the default tab):
- the **Downloads** list — every title Debridarr has cached, with its size,
  ratio or download progress, and time left on its lease — and Keep, Release,
  or Delete any of them (these act immediately, not through Save);
- the private addon manifest URL, copy/install controls, and **Replace installation link** to revoke old installations.

**Library** tab:
- **Retention** (lease length — 30/60/90 or a custom number of days — target
  seed ratio, grace period, extend-on-play, and a cache cap);
- **Preferences**: check off as many resolutions, codecs, and languages as you
  want — e.g. only 4K and 1080p, only x265 (smaller files at the same
  quality than x264), only English and French. Leaving a group entirely
  unchecked means no filter there; a release with no readable resolution,
  codec, or language tag at all is always shown regardless (Debridarr can't
  tell, so it doesn't guess). The language options are the set Debridarr can
  actually detect in release names.

**Connections** tab:
- the Prowlarr URL and API key, and the qBittorrent URL, username, and
  password, each with a live **Test connection** that doesn't save;
- the metadata provider — **Cinemeta** (no key) or **TMDB** (needs a v3 API
  key), which turns Stremio ids into titles and years for searching.

Secrets are write-only in the UI: saved API keys and passwords are never sent
back to the browser, and each secret field offers keep / replace / clear.
Sessions last 12 hours and are held in memory, so restarting the container
requires signing in again. Repeated failed logins from one address are throttled.

The site pins requests to `APP_URL`: set it to the origin you actually load the
page from (including when behind a reverse proxy), or logins are rejected.

## Connect Stremio

Sign in at `/configure` and use **Install addon**, or copy the private manifest URL
into Stremio's addon URL/search field. It has the form
`https://your-host/addon/{key}/manifest.json`. Set `APP_URL` to an address reachable
from your Stremio devices before copying the link.

The generated key grants access to search, downloads and playback. Keep it private.
**Replace installation link** revokes the previous key and release references;
reinstall the addon on each device afterward. Already-open file streams can finish.

The manifest advertises movie and series streams. Once Prowlarr is configured,
opening a movie or episode lists ranked releases from your indexers, labelled with
resolution, source, size, seeders, and indexer, filtered to your configured
language/quality preferences (if any) and to releases whose title — including
an original-language title, when your metadata provider gives one — actually
matches. Choosing one:

1. adds the torrent to qBittorrent (category `debridarr`) — from a magnet, an
   infohash, or by fetching the release's `.torrent` file and uploading it
   directly (so private-tracker releases with no magnet still work) — turns on
   sequential + first/last-piece download, and — in a season pack —
   deprioritises files that have never been selected (previously selected episodes stay enabled);
2. streams the file back to Stremio once it has finished downloading, with HTTP
   range support for seeking.

While the file is still downloading, the protected playback route returns `503` with a progress
figure and Stremio shows an error; try again once it is further along. With
qBittorrent unconfigured you get a clear `503`; if the finished file is not
visible in `DOWNLOAD_DIR` you get a `502`. With Prowlarr unconfigured, or on a
search error, the stream list is simply empty. The service does not provide
catalogs.

Downloaded titles aren't kept forever: each gets a lease (30 days by default)
that's only allowed to expire once its seed ratio has reached a configurable
target, and playing a title renews its lease by default. Mark a title Keep, in
the Downloads list on `/configure`, to exempt it from expiry entirely. An
hourly sweeper enforces this and never touches a title mid-stream.

For clients that require HTTPS, use an HTTPS reverse proxy and set `APP_URL` to
its external origin. Avoid recording `/addon/` request paths in proxy access logs:
these paths contain the private installation key. `/health` remains public.

## Security update and existing installations

Back up your existing data volume before upgrading. Keep the same volume; do not
remove or rename it. This update retires the public `/manifest.json`, `/stream/…`
and `/play/…` routes. **Reinstall Debridarr using the private link in `/configure`.**
If you deployed a previous version, rotate the Prowlarr API key in Prowlarr and
save the replacement in Debridarr: old playback links could expose that key.
Debridarr does not rotate external credentials automatically.

Release details, including torrent source URLs, stay in `addon.json` on the server.
Playback links contain random references lasting 24 hours, with a maximum of
1,000 stored entries (16 KiB per entry). Oldest references can be evicted earlier;
search again if a link expires. Changing Prowlarr connection settings invalidates
existing references. Only the configured Prowlarr download-proxy endpoint can
receive its API key. Redirects are limited to five hops; HTTP(S) redirect targets
must resolve to public addresses, pinned for the connection. Local/private
redirect targets and arbitrary direct torrent URLs are rejected. Valid magnet
redirects and the original torrent's tracker information are preserved.

Debridarr refuses to adopt or modify an unrelated existing torrent (`409`). Managed
torrents require a local record, a matching qBittorrent endpoint, the recorded
category, and a unique ownership tag. Legacy records migrate only when their hash,
recorded file and size, and `debridarr` or `debridgerr` category match the client.
Unmatched records remain visible as ownership conflicts. Restore the original
client/category to resolve a conflict; don't delete the tracking file to bypass it.
Global qBittorrent preferences are never changed. Owned torrents get unlimited
per-torrent share limits to prevent inherited automatic removal; the hourly sweep
stops seeding at the configured ratio and enforces retention itself.

Registration intent is saved before adding a torrent. Interrupted preparations
are reconciled on startup and hourly; unplayable additions stay tracked until
verified cleanup succeeds. Pending deletion blocks new playback and Keep actions.
A failed deletion remains visible and retryable until qBittorrent confirms absence.
Keep and active playback protect against automatic deletion. Explicit manual
Delete still removes a kept title. A soft cache cap may override the ratio target,
but rechecks Keep, playback reservations and lease changes before eviction.

Playback requires Linux and a regular completed file. Descriptor-based path
walking refuses symlinks and traversal; stat and streaming use the same open file.
Mount downloads read-only. The service remains a single-instance application:
**do not run multiple replicas against one data directory**.

Per-instance admission limits are four simultaneous searches, thirty searches per
minute, two torrent preparations, sixteen playback requests and ten incomplete
managed downloads. Saturation returns `429` with `Retry-After`; requests aren't
queued indefinitely.

## Local development

Use Node.js 24 LTS (`nvm use` if you use nvm) and npm.

```sh
npm ci
cp .env.example .env
# set ADMIN_PASSWORD in .env
npm run dev
```

`npm run dev` builds once, then watches `src/` and `web/` and restarts. For a
production build:

```sh
npm run typecheck
npm test
npm run build
npm start
```

End-to-end browser coverage of the configuration site:

```sh
npm run test:e2e
```

The production application has no third-party runtime dependencies. Development
uses TypeScript and tsx; unit tests use Node's built-in test runner and the
end-to-end test uses Playwright.

## Configuration

Local scripts load `.env` when present; existing process environment values take
precedence. Compose forwards the listed settings to the container.

### Deployment settings (environment only, fixed at runtime)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7000` | Listening and Compose host port; integer from 1–65535. |
| `APP_URL` | `http://localhost:${PORT}` | Public origin of the site; HTTP(S), no path, credentials, query, or fragment. Used to pin admin requests and build the manifest URL. |
| `ADMIN_PASSWORD` | — | **Required.** Password for the `/configure` site. No default. |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Absolute path for `settings.json`, `downloads.json`, and `addon.json` (`0600` files, `0700` directory). |
| `DOWNLOAD_DIR` | `/downloads` | Absolute path where Debridarr sees qBittorrent's completed downloads. Mount qBittorrent's download tree here (ideally at the same path qBittorrent uses). Linux only; files must be regular files inside it, without symlinks. |

### Integration settings (managed in the website; environment seeds first run only)

| Variable | Purpose |
| --- | --- |
| `PROWLARR_URL` | Prowlarr HTTP(S) base URL, including any URL base path. |
| `PROWLARR_API_KEY` | Prowlarr API credential. |
| `QBITTORRENT_URL` | qBittorrent Web UI/API HTTP(S) base URL. |
| `QBITTORRENT_USERNAME` | qBittorrent login. |
| `QBITTORRENT_PASSWORD` | qBittorrent password. |
| `METADATA_PROVIDER` | `cinemeta` (default) or `tmdb`. |
| `TMDB_API_KEY` | TMDB v3 API key; required only when the provider is `tmdb`. |

These are read **only when `settings.json` does not exist**, to seed it.
After that, edit them at `/configure`; later environment changes are ignored.
Leave them blank to configure everything through the website. Blank values count
as unset. Supplied URLs are validated; put credentials in their dedicated fields,
not URL userinfo or query parameters. Credentials are never logged and are never
returned by the API. Saving does not run a connection check — use the Test
buttons.

Use service addresses reachable from inside the Debridarr container. `localhost`
inside it refers to Debridarr itself. Existing containers can be reached over a
shared Docker network by service name, or through reachable host ports.

Mount qBittorrent's downloads into Debridarr (read-only is fine); a commented
example is in `compose.yaml`. The container's non-root user must have
read/traverse permissions. Mount it at the same path qBittorrent uses, or set
`DOWNLOAD_DIR` to where it lands in the Debridarr container — Debridarr tries
both. A configurable prefix remap for stranger layouts is not implemented yet.

## Architecture

```text
Stremio id → metadata resolution → Prowlarr search → filter/rank → stream list  ✅
private release reference → owned qBittorrent download → wait for completion → range HTTP playback  ✅ (full files only)
downloaded title → fixed cache lease, seed to target ratio, then delete         ✅
```

- `src/server.ts` owns HTTP routing: the configuration site, the `/api/admin/*`
  API, and the addon protocol (`/stream`, `/play`), with strict security headers.
- `src/config.ts` validates deployment environment settings.
- `src/settings.ts` persists and redacts the runtime-editable integration,
  retention, and search-preference settings; `src/admin/` implements session
  auth and the admin API (settings and downloads endpoints).
- `src/metadata/` resolves ids to titles (and, when available, an
  original-language alternate title) via the configured provider (Cinemeta or
  TMDB).
- `src/integrations/` holds the Prowlarr client (connection test + release
  search) and the qBittorrent client (connection test, torrent and
  torrent-file-upload operations, ownership tags, per-torrent stop/start), plus
  a shared fetch helper.
- `src/search/` parses (including language tags), matches (including alternate
  titles), filters by preference, deduplicates, and ranks releases.
- `src/downloads/` coordinates ownership, registration, selection and deletion of torrents in qBittorrent (from a magnet, infohash,
  or a fetched `.torrent` file), picks the file, and keeps `downloads.json`.
- `src/playback/` maps the file into `DOWNLOAD_DIR`, serves it with range
  support, and tracks which torrents are actively being streamed.
- `src/retention/` runs the hourly sweeper that enforces the cache lease.
- `src/addon/` owns the manifest, the search-backed stream list, and the
  internal release type; `web/` is the configuration site.
- `src/security/` manages private installation keys, opaque references, admission
  limits and constrained torrent source requests.

Browsing stream results must not trigger downloads; selecting one (the `/play`
request) does.

The HTTP shell follows the [Stremio addon protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)
and [manifest definition](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md).
It serves public `/health` and protected `/addon/{key}/manifest.json`,
`/addon/{key}/stream/{type}/{id}.json`, and `/addon/{key}/play/{reference}` with CORS. Supported IDs are `tt1234567` for movies and
`tt1234567:1:2` for episodes (season 0 is allowed for specials). Unsupported
routes/types/IDs and expired or unrecognised release references return JSON 404; malformed stream
URL encoding returns 400; unsupported methods return 405. HEAD and OPTIONS are
supported. `/health` reports only that the application is serving requests.

See [HANDOVER.md](HANDOVER.md) for progress, verification, and the next milestones.
