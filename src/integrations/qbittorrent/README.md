# qBittorrent integration

`QBittorrentClient` handles Web API authentication and torrent operations for
playback, administration and retention. It reuses its session and retries one
expired authentication response. Responses are bounded and upstream bodies are
not exposed as errors.

- `test()` / `version()`: connection check.
- `torrent(hash)` / `files(hash)`: normalized status, including category/tags,
  and file list. Direct hash lookups confirm absence before removing tracking.
- `torrentsByCategory(category)`: dashboard status listing.
- `add` / `addTorrentFile`: category and ownership tag on creation, optional
  paused/stopped state, automatic torrent management off and unlimited share
  limits. Raw torrent upload preserves trackers and web seeds.
- `addTags`: verified legacy migration.
- `setFilePriorities`, `setShareLimits`, `setSequential`,
  `setFirstLastPiecePriority`: per-torrent download configuration.
- `setRunning`: start/stop on qBittorrent 5+, resume/pause on earlier versions.
- `delete`: caller must verify ownership and confirm subsequent absence.

There are no global preference writes. The client endpoint fingerprint plus
local ownership record, category and unique tag define Debridarr ownership;
see `src/downloads/ownership.ts`. Independent external applications cannot be
serialized by Debridarr's process-local coordinator.

Per-torrent share-limit values and versioned endpoints follow the official
[qBittorrent Web API documentation](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-5.0)).
