# Roadmap

Work after Stage 7 and the P1–P3 hardening pass. Features here are inspired by
modern debrid APIs (especially TorBox) but shaped for Debridarr: a self-hosted
orchestrator over an external download client, not a commercial CDN.

## Constraints

- The native API (`/api/v1` over `TransferService`) is the product boundary.
  Stremio, StremThru, and Real-Debrid routes stay adapters.
- One download backend at a time. Branch on declared capabilities, never on
  backend type string.
- Do not start a download without durable ownership proof.
- No built-in BitTorrent engine, no shared commercial cache, no hoster
  unlocking, no ffmpeg transcoding farm.
- One independently verifiable slice at a time. Do not combine a storage-shape
  change, an API change, and a new client pin in one slice.
- Verify: `npm run typecheck`, `npm test`, and Playwright when UI changes.

## Status

| Slice | Status |
| --- | --- |
| 1. Overflow queue and add-only-if-cached | Done |
| 2. Pause, resume, and preview without adding | Done |
| 3. Completion webhook | Done |
| 4. RSS saved searches | Done |
| 5. Permalink redirect and zip of a transfer | Done |
| 6. Read-only WebDAV of completed files | Done |

## Out of scope

- Hoster / webdl unrestrict (Mega, 1Fichier, arbitrary URLs). `downloadUrl`
  stays limited to configured discovery origins.
- Fake instant-availability against a global cache. Local “already owned”
  checks only. The Real-Debrid adapter keeps `instantAvailability` as `501`.
- Cloud offload (Drive, Dropbox, OneDrive). Use rclone on the host.
- A hosted torrent search index. Prowlarr / Torznab remains discovery.
- Always-download-all-files. Select-on-play stays the home-library default.

---

## Slice 1 — Overflow queue and add-only-if-cached

TorBox: `as_queued` and `add_only_if_cached` on create.

Today a full `maxActiveDownloads` or a miss on a “cached only” client is a hard
error. Clients expect “accept it and start later” or “succeed only if it is
already here.”

**Add**

- `POST /api/v1/transfers` accepts `queue: true`. When at the active cap, persist
  the transfer as `lifecycle: 'queued'` instead of `503`.
- `cachedOnly: true` (name TBD) succeeds only if this identity is already a
  managed transfer with a playable file. No backend submit. Local check, not a
  commercial cache.
- A job admits the next queued transfer when a slot frees (delete, complete, or
  cap raised). FIFO unless a later slice adds priority.
- Dashboard shows queued rows and a cancel that drops the record without
  touching the backend.
- Capabilities report `queue` and `cachedOnly`.

**Stay out:** a second queue table if `lifecycle` on the existing download
record is enough. Do not start queued work that fails ownership or free-space
checks.

**Verify:** create-at-cap returns queued; admission starts one when a slot
opens; `cachedOnly` on a missing hash does not add; dashboard cancel; existing
create-at-cap `503` callers still make sense (default remains reject unless
`queue: true`).

---

## Slice 2 — Pause, resume, and preview without adding

TorBox: `controltorrent` pause/resume/reannounce; `torrentinfo` without creating
a download.

**Add**

- `POST /api/v1/transfers/{id}/pause` and `/resume` (names TBD) mapped to
  backend `setRunning` where the capability exists. Usenet pause is SABnzbd
  pause of that job.
- Dashboard Pause / Resume on active rows.
- `POST /api/v1/transfers/preview` with a magnet, infohash, or torrent file:
  name, size, files, seeders if the backend can report them, **no durable
  record**. Prefer a stopped add + files + delete probe; never leave the probe
  owned if the request fails.

**Stay out:** reannounce until a backend declares it. Do not download the
preview.

**Verify:** pause stops progress; resume continues; preview does not appear in
`GET /transfers`; a failed preview leaves no backend job.

---

## Slice 3 — Completion webhook

TorBox: many notification channels. For a single operator, one webhook is
enough.

**Add**

- Settings: optional HTTPS webhook URL (Connections).
- POST JSON on `managed`, `failed`, and confirmed `deleted`: `{event, id, name,
  lifecycle, media?}`. Secret header optional (HMAC of the body).
- Fire from the existing recovery/sweep/create path, not a new poller. Time out
  and log; never block playback or admission.

**Stay out:** email, Discord, Telegram bots.

**Verify:** completing a transfer hits a test listener; a failing webhook does
not fail the transfer; Search-only mode has no setting.

---

## Slice 4 — RSS saved searches

TorBox: first-class RSS for torrent and usenet feeds.

**Add**

- One or more saved searches: feed URL, optional title include/exclude, protocol
  (torrent or usenet), optional `cachedOnly` / `queue`.
- A job polls on an interval, adds new items through `TransferService.add`
  (magnet, torrent URL, or NZB URL from the feed).
- Dashboard: last poll, last error, skip/ignore an item.
- Feed URLs go through the same SSRF allowlist as discovery `downloadUrl`
  (configured provider origins, or an explicit allow list of feed hosts).

**Stay out:** scraping HTML indexers; generic web-file RSS.

**Verify:** a local RSS fixture adds one magnet; duplicates are skipped;
disabling the search stops adds.

---

## Slice 5 — Permalink redirect and zip of a transfer

TorBox: `requestdl?redirect=true` permalinks; `zip_link` for the whole torrent.

**Add**

- `GET /api/v1/transfers/{id}/files/{fileId}/go` (`link` scope, or token in
  query for dumb clients) returns `302` to a fresh signed `/api/v1/download/`
  URL. Stable bookmark; short-lived file URL.
- `GET /api/v1/transfers/{id}/zip` streams a zip of selected (or all playable)
  completed files. Do not buffer the archive in memory.
- Dashboard “Copy permalink” next to the existing 24-hour expiry note.

**Stay out:** zipping incomplete files; a second CDN.

**Verify:** permalink 302 then 200 range GET; zip contains the selected videos;
incomplete transfer is `409`/`503`.

---

## Slice 6 — Read-only WebDAV of completed files

TorBox WebDAV is how Infuse, VLC, Jellyfin, and rclone consume the library
without Stremio.

**Add**

- Read-only WebDAV under a dedicated path (e.g. `/dav/`), authenticated with an
  API token (`read` + `link` or a dav-specific scope).
- Tree: transfer name / file path, completed selected files only, confined to
  `DOWNLOAD_DIR` with the existing path mapping.
- PROPFIND, GET with Range, no PUT/DELETE/MOVE.

**Stay out:** write access; exposing incomplete/piece-gated files.

**Verify:** cadaver or a Node WebDAV client lists a completed transfer and
reads a range; traversal outside the download root fails.

---

## Later, if still wanted

- Tags or a display name on a transfer (WebDAV folders, dashboard filters).
- `activeCount` / queued depth / free space on `/capabilities` and the dashboard.
- Export magnet or `.torrent` for an owned transfer.
- Per-transfer seed override.
- Sidecar subtitle files next to a video (no transcoding).
- SABnzbd RAR password / PAR2 options passed through on NZB add.

These are not slices until 1–6 are done or a later pass reprioritizes them.
