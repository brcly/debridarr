# Retention

Enforces the "debrid-like" cache policy agreed for Debridarr: a downloaded
title is kept for a fixed lease, then deleted — but not before it has seeded
to the target ratio, and never if the admin marked it Keep.

- `sweeper.ts` — `sweepOnce({ store, downloads })`: enumerates the
  `debridarr` qBittorrent category (one request, via
  `QBittorrentClient.torrentsByCategory`), cross-references it with
  `DownloadsStore`, and:
  1. Removes any `DownloadsStore` record whose torrent is no longer in that
     category (cleaned up some other way).
  2. Deletes (torrent + files) any non-kept, non-actively-streamed record once
     `now ≥ expiresAt` and either the seed ratio has reached
     `retention.targetRatio`, or `retention.graceDays` has also elapsed past
     expiry (`graceDays: 0` means never force it).
  3. If `retention.maxCacheGB` is set, evicts the soonest-to-expire non-kept,
     non-active survivors (by total torrent size) until back under the cap.
  4. Best-effort sets qBittorrent's global ratio-limit action to `pause` — see
     `src/integrations/qbittorrent/README.md`.

  A title currently being streamed (tracked in `src/playback/active.ts`) is
  never touched. `qbtFactory`, `isActive`, and `now` are injectable for tests;
  in production `sweepOnce` always builds a fresh `QBittorrentClient` from the
  current settings snapshot, so a runtime settings edit takes effect on the
  next sweep without a restart. A qBittorrent outage aborts the sweep (nothing
  is deleted) rather than being treated as "every torrent is gone".

`src/index.ts` runs a sweep on startup and hourly thereafter, skipping a tick
if the previous one is still running.

Not yet built: a config-site page to browse/Keep/Release/Delete downloads (the
admin JSON API for it exists — see `src/admin/routes.ts` — but there's no UI
yet).
