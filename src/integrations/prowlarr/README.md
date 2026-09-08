# Prowlarr integration

`ProwlarrClient` owns authentication (the `X-Api-Key` header), the base-path
prefix, timeouts, and mapping Prowlarr responses.

- `test()` / `version()` — connection check against `/api/v1/system/status`.
- `search(query, signal, categories)` — full-text release search against
  `/api/v1/search`. Prowlarr aggregates per-indexer results and failures
  server-side, so a non-2xx here means Prowlarr itself failed. Results are
  normalized to `ProwlarrRelease` and filtered to `protocol: 'torrent'`
  (qBittorrent cannot fetch usenet). Query construction, matching, deduplication,
  and ranking live in `src/search`, not here.

Indexer coverage depends on the user's Prowlarr configuration; support for any
particular torrent site is not guaranteed. Query construction and preference
filtering (language, resolution cap) live in `src/search`; adding the selected
release to qBittorrent lives in `src/downloads`.
