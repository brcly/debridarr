# Changelog

## 0.2.0 — 2026-09-12

### Added

- Search, Store, and Both operating modes with a private Stremio addon,
  multi-provider discovery, saved RSS/Torznab searches, and per-provider
  language, resolution, and codec preferences.
- Native `/api/v1`, StremThru Store v0, Real-Debrid REST 1.0, and read-only
  WebDAV surfaces with scoped API tokens, request quotas, idempotent transfer
  creation, file selection, signed playback links, and OpenAPI documentation.
- qBittorrent, Transmission, Deluge, and SABnzbd download backends behind one
  capability contract.
- Transfer retention, active-download limits, minimum-free-space enforcement,
  recovery and deletion-retry jobs, completion webhooks, playback diagnostics,
  request correlation IDs, and operator metrics.
- CI checks on Node 24 and 26, coverage thresholds, dependency auditing,
  Dependabot, container smoke tests, and automated WCAG accessibility checks.

### Changed

- SQLite is the default state driver. Existing JSON state is imported once and
  backed up automatically; the legacy JSON driver now also persists scheduled
  jobs, deletion retries, and API idempotency records.
- The administration UI is split into focused setup, discovery, saved-search,
  download, and token modules. Its pure formatting and mapping helpers have
  direct unit coverage.
- Readiness checks now probe the configured backend and download mount. Static
  administration assets are cached in memory and revalidated with ETags.
- SQLite state uses an exclusive data-directory lock, incremental auto-vacuum,
  periodic optimization, and a versioned migration runner with a
  forward-version guard.
- Node.js 24 or newer is supported. The production container remains pinned to
  one Node major.

### Fixed

- Trusted-proxy client addressing prevents one proxy user from consuming every
  login, token, or playback limit when `TRUSTED_PROXIES` is configured.
- Admin API failures from HTML-producing proxies and body limits now show
  status-based messages instead of JSON parse errors.
- Malformed RSS with many unclosed item tags is parsed in linear time rather
  than blocking the event loop quadratically.
- Expired addon playback references are pruned during retention sweeps.
- Download list sorting is cached between writes, and dashboard polling updates
  rows without discarding focused controls.

### Upgrade notes

1. Follow the backup procedure in [docs/operations.md](docs/operations.md)
   before upgrading. The state directory and its backups contain plaintext
   integration credentials.
2. Set `ADMIN_PASSWORD` to at least 12 characters. Startup rejects shorter
   values.
3. Run only one Debridarr process per `DATA_DIR`. A second process now fails
   at startup with the owning PID instead of sharing process-local state.
4. Existing JSON installations migrate automatically on the first default
   SQLite startup. The original JSON files are moved to a timestamped backup
   directory after a successful atomic import.
5. Settings schemas 1–16 migrate in memory and save as schema 17. Legacy
   qBittorrent, Prowlarr, preference, retention, playback, webhook, and RSS
   fields are preserved through their corresponding migrations.
6. `store.json` schema 1 gains token scopes and a link-signing secret.
   `addon.json` schema 1/2 preserves the installation key but discards old
   short-lived playback references; browse again to obtain fresh links.
7. Existing installations keep minimum-free-space enforcement disabled until
   configured. Fresh installs default to 1 GB. Partial playback remains
   disabled unless explicitly enabled under Library.
8. Rollback requires the older image and its matching pre-upgrade backup. An
   older build refuses state written by a newer schema.
