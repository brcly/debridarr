// Centralised AbortSignal.timeout() budgets. These used to be raw literals
// repeated at each call site (see improvements.md P1-14); collecting them
// here makes the actual distinct values visible in one place.
//
// DEFAULT_METADATA_WAIT_MS and DEFAULT_BUFFER_WAIT_MS matter most on slow
// hardware — a congested backend or a cold torrent can take longer than
// usual to report metadata or buffer a piece — so they're operator-tunable
// via DEBRIDARR_METADATA_WAIT_MS / DEBRIDARR_BUFFER_WAIT_MS (see
// src/config.ts and docs/configuration.md); the values here are only the
// fallback defaults. Everything else below is an internal budget, not meant
// to be tuned by operators.

// Default test() budget shared by admin/diagnostics.ts and every
// integration client (qBittorrent, Transmission, Deluge, SABnzbd, Prowlarr,
// Torznab).
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;

// addon/streams.ts: deadline for one Stremio search fan-out.
export const SEARCH_DEADLINE_MS = 8_000;
// addon/streams.ts: reading cached-copy state from the backend while
// building search results.
export const CACHED_COPIES_TIMEOUT_MS = 5_000;
// api/v1/routes.ts: deadline for a native REST discovery request.
export const DISCOVER_DEADLINE_MS = 20_000;
// rss/poll.ts: fetching a saved search's Torznab feed.
export const FEED_TIMEOUT_MS = 20_000;

// admin/diagnostics.ts, application/transfers.ts, backends/snapshot.ts,
// downloads/recovery.ts: short backend status reads/checks (get/getFiles/
// list/test) outside a longer-lived operation.
export const BACKEND_READ_TIMEOUT_MS = 5_000;
// admin/diagnostics.ts (listing + free-space during diagnostics),
// application/transfers.ts: pausing or removing a torrent at the backend.
export const BACKEND_ACTION_TIMEOUT_MS = 8_000;
// application/transfers.ts: probing whether an unregistered torrent already
// exists live at the backend before adding it (tracker/DHT lookups can be
// slow, so this gets a generous budget).
export const PREVIEW_PROBE_TIMEOUT_MS = 30_000;
// admin/routes.ts: naming a store item before it has metadata, and deleting
// a managed download from the dashboard.
export const ADMIN_ACTION_TIMEOUT_MS = 10_000;
// application/transfers.ts, downloads/queue.ts: ensureTransfer's own
// backend submit call (adding a torrent/nzb).
export const TRANSFER_SUBMIT_TIMEOUT_MS = 90_000;
// application/transfers.ts: ensureTransfer used for file selection, and
// admin/routes.ts's delete action.
export const TRANSFER_ACTION_TIMEOUT_MS = 15_000;
// dav/routes.ts: WebDAV listing/read backend calls.
export const DAV_TIMEOUT_MS = 15_000;
// downloads/manager.ts: waiting for the backend to acknowledge a freshly
// submitted torrent exists at all.
export const REGISTER_TIMEOUT_MS = 12_000;
// downloads/manager.ts: ensureTransfer's own fallback when a caller omits
// metadataTimeoutMs. Every current caller sets it explicitly (0 to skip
// waiting, or DEFAULT_METADATA_WAIT_MS to wait), so this is a defensive
// default rather than a value exercised in production.
export const MANAGER_METADATA_FALLBACK_MS = 20_000;
// retention/sweeper.ts: per-sweep and per-retry backend calls.
export const SWEEP_TIMEOUT_MS = 60_000;
// webhooks/dispatch.ts: delivering one webhook.
export const WEBHOOK_TIMEOUT_MS = 10_000;
// server.ts: /health/ready's backend probe.
export const READY_BACKEND_TIMEOUT_MS = 5_000;

// playback/index.ts: overall deadline to prepare a transfer for playback
// (add torrent, wait for admission) before giving up.
export const PREPARE_DEADLINE_MS = 150_000;
// playback/index.ts, playback/pieces.ts: cap on a single mid-wait re-probe
// of backend/piece state, so a long metadata/buffer budget still re-checks
// periodically instead of sleeping for the whole deadline at once.
export const PROBE_TIMEOUT_MS = 10_000;
// How long a playback request waits for a brand-new torrent's metadata
// before falling back to the "still downloading" placeholder. Recovery
// keeps working on it in the background.
export const DEFAULT_METADATA_WAIT_MS = 8_000;
// How long a playback request waits for the piece(s) covering a requested
// byte range to finish downloading before it gives up.
export const DEFAULT_BUFFER_WAIT_MS = 120_000;
