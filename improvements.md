# Improvements required before 0.2.0

Full-project audit of commit `a78a566` (branch `dev`, 2026-09-12). Every item
below was verified against the working tree; file references are
`path:line` at that commit.

The finding text is retained as the historical audit record. Heading status,
the P2 bullet status, the definition-of-done checklist, and the progress log at
the end describe the current tree.

## Verification baseline

Run during this audit, on this machine:

| Check | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | clean (both `tsconfig.json` and `tsconfig.web.json`) |
| Unit / integration | `npm test` | 331 pass, 0 fail, 9.5 s |
| Browser | `npx playwright test` | 4 pass, 13.9 s |
| Dependencies | `npm audit` | 0 vulnerabilities (0 runtime dependencies) |

Size: 106 TypeScript files / 10,714 lines in `src`, 2,110 lines in `web`,
8,221 lines across 49 test files, 1,051 lines in `docs/`.

**Nothing in this document is a known-broken behaviour.** The build is green
and the feature set in `ROADMAP.md` is complete (slices 1–6 all done). These
are the gaps between "works on the author's machine" and "a version other
people install, upgrade and report bugs against".

## What is already in good shape

Worth stating, because it shapes the priorities below:

- Zero runtime dependencies; everything is Node stdlib. Supply-chain surface
  is essentially the base image.
- Repository pattern with two drivers behind one contract
  (`src/state/repositories.ts`), and a real contract test (`test/state-contract.test.ts`).
- The application seam (`TransferService`) genuinely has no HTTP or backend
  coupling; adapters (Stremio, StremThru, Real-Debrid, WebDAV) sit outside it.
- Path confinement for playback is unusually careful: descriptor-walk with
  `O_NOFOLLOW` per component (`src/playback/paths.ts:49-70`).
- Secrets are never echoed to clients — `publicSettings()` exposes only
  `hasPassword` / `hasApiKey` booleans (`src/settings.ts:470-493`).
- The admin UI is XSS-safe by construction: 87 `textContent` assignments and
  zero `innerHTML` / `insertAdjacentHTML` / `eval` in `web/app.ts`.
- Settings migrations are versioned to v17 with a real read-path migration.
- `SECURITY.md` states the trust model honestly, including accepted risks.

---

## P0 — blockers for tagging 0.2.0

### P0-1 · SQLite has no migration path, and no forward-version guard — Done

`openDatabase()` only runs `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS` (`src/state/sqlite/db.ts:71-84`), `SCHEMA_VERSION` is the string `'1'`
(`db.ts:106`), and `importState()` returns immediately whenever a
`schema_version` row exists (`src/state/importer.ts:28`).

Consequences for a 0.2.0 that changes anything about the schema:

- A new **column** or a changed constraint will never be applied to an
  existing install. New tables happen to work; nothing else does.
- An older binary opening a newer database sees `schema_version` set, skips
  everything, and runs against a shape it does not understand.

Do before 0.2.0: an ordered migration runner (numbered steps, each in its own
transaction, recorded in `meta`), a refusal to start when
`schema_version > SCHEMA_VERSION` with a message naming the required version,
and a test that opens a v1 fixture database and asserts the upgrade.
This is the one item that is expensive to retrofit *after* users have data.

### P0-2 · Release mechanics do not exist yet — Release preparation done; tag pending

`package.json` is still `0.1.0-beta.1` with `"private": true`, and
`CHANGELOG.md` has exactly one section: `## 0.1.0-beta.1 — Unreleased`. The
publish job fires on `refs/tags/v*` (`.github/workflows/container.yml:8`, published by the job gated at `:104`) but
nothing checks that the tag matches the version in `package.json`, and no
document describes how a release is cut.

Do before 0.2.0:

- Decide whether 0.2.0 supersedes the unreleased beta or ships as
  `0.2.0-beta.1`, and reflect it in `package.json`, `CHANGELOG.md` and
  `docs/compatibility.md`.
- Add a CI step asserting `v$(node -p "require('./package.json').version")`
  equals `github.ref_name` on tag builds.
- Add a `## 0.2.0` section written for upgraders, not for the author: what
  changed, what migrates, what to back up first (`docs/operations.md:39-43`
  already has the tar command to point at).
- `CHANGELOG.md` currently mixes shipped features and upgrade notes in one
  90-line bullet list. Split "Added / Changed / Fixed / Upgrade notes".

The release is now consistently prepared as 0.2.0 in `package.json`, the lock
file, addon manifest, changelog, and compatibility guide. The changelog is
organised for operators, `docs/releasing.md` documents the release procedure,
and `npm run check:release -- v0.2.0` verifies the tag, package version,
changelog section, and compatibility text. The tag workflow runs that check.
The annotated `v0.2.0` tag is created from the merged release commit when the
release is published; it is deliberately not created from an uncommitted
working tree.

### P0-3 · CI never runs on the branch where the work happens — Done

Triggers are `pull_request → main`, `push → main`, and tags
(`.github/workflows/container.yml:3-9`). All five most recent commits are on
`dev`, so typecheck, tests, browser tests and the image smoke test have not
run on any of them in CI — only locally, by hand.

Do before 0.2.0: add `push: branches: [main, dev]` (the existing
`concurrency` block already cancels superseded runs), or make `dev → main`
pull requests mandatory and protect `main`.

### P0-4 · No lint or format gate at all — Done

There is no ESLint, Biome, oxlint, Prettier or `.editorconfig` anywhere in the
repo, and no `lint` script in `package.json`. 12.8k lines of source are held
to a consistent style purely by review.

The codebase is clean enough that this is cheap to add now and painful later:
zero `any`, zero `@ts-ignore`, zero stray `console.*` outside `src/log.ts`.
Adopt one linter, run it in the `unit` job, and fix the first-run findings in
a single mechanical commit *before* 0.2.0 so the diff never lands mid-release.

### P0-5 · No coverage signal — Done

`"test": "node --import tsx --test test/*.test.ts"` — no
`--experimental-test-coverage`, no threshold, no report uploaded. 8,221 lines
of tests exist with no measurement of what they miss.

Do before 0.2.0: enable coverage, publish the summary in CI, and set a floor
that today's suite already clears. Without it, "0.2.0 is well tested" is an
assertion, not a fact. Known blind spots to check once the numbers exist:
`src/log.ts`, `src/server.ts` routing branches, `web/app.ts` (no unit tests at
all — see P1-8).

### P0-6 · `DEBRIDARR_STATE=json` silently drops idempotency and job state — Done

`openState()` gives the JSON driver in-memory-only idempotency and jobs, and a
no-op `close` (`src/state/init.ts:37-39`):

```ts
const idempotency = new JsonIdempotencyStore();
const jobs = new JsonJobsStore();
return { ..., close: () => {} };
```

Recurring jobs are re-seeded by `JobRunner.start()` so sweep/recovery/rss
survive, but two things do not:

- A **deletion retry** scheduled by `scheduleDeletionRetry()`
  (`src/jobs/runner.ts:84`) is lost on restart — the backend torrent and its
  files stay behind with nothing left to retry them.
- Every **`Idempotency-Key`** is lost, so a client retrying a `POST
  /api/v1/transfers` across a restart creates a second transfer. That is a
  correctness difference between the two drivers that the shared contract test
  cannot see.

Do before 0.2.0: either persist both for the JSON driver, or demote JSON to
"migration-only, read-path" in `docs/configuration.md` and refuse to start the
job runner and the native API idempotency cache on it. Do not ship 0.2.0 with
two drivers that disagree about durability and no documentation of which.

The JSON driver now stores jobs in `jobs.json` and idempotency records in
`idempotency.json` using the same queued atomic-write pattern as its other
repositories. Both files are validated strictly on open and protected with
owner-only permissions. The shared state contract now closes and reopens each
driver and proves that both record types survive restart.

### P0-7 · Declared Node range excludes the runtime this was tested on — Done

`engines: ">=24 <25"`, `.nvmrc` says `24`, `Dockerfile` pins `node:24-bookworm-slim`.
This audit ran the entire suite on **Node v26.8.1** — 331 tests, 4 browser
tests, typecheck, all green. The upper bound therefore blocks users and
contributors on Node 25/26 for no demonstrated reason, and `npm ci` fails
outright under `engine-strict`.

Do before 0.2.0: widen to `>=24`, and run the `unit` job on a matrix
(`24` and the current LTS) so the claim is backed by CI rather than by one
developer's machine. Keep the container pinned to a single major.

---

## P1 — fix before, or explicitly defer with a written reason

### P1-1 · Abuse limiting breaks in the deployment the docs recommend — Done

Login throttling and store-token throttling key on `request.socket.remoteAddress`
(`src/api/v1/routes.ts:62`, `src/dav/routes.ts:136`), and `SECURITY.md`
documents the consequence: behind a reverse proxy every client shares one
address, so five failed logins lock out the real administrator for 15 minutes,
and admission slots are shared globally.

This is listed as an accepted risk, but the same documentation set tells every
user to put a TLS-terminating proxy in front (`SECURITY.md`, "Serve HTTPS
off-host"). The recommended deployment is the broken one. Add an opt-in
`TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_CIDRS` config that permits
`X-Forwarded-For` parsing only from configured peers, defaulting to today's
behaviour.

### P1-2 · Integration secrets are plaintext at rest — Done for 0.2.0

The download-client password, every discovery provider API key, the TMDB key
and the webhook signing secret live in the `settings` row / `settings.json` as
plaintext, protected only by `0600` on the file and `0700` on the directory
(`src/state/sqlite/db.ts:87-95`, `src/state/json/settings.ts:20-29`).

`docs/operations.md:39-43` tells operators to `tar` the whole data directory
into `backups/` — that tarball is a credential dump, and the doc does not say
so. Minimum for 0.2.0: state this explicitly in `docs/operations.md` and
`SECURITY.md`. Better: encrypt secret fields with a key held in a separate
file (or `DEBRIDARR_SECRET_KEY`), so a leaked backup is not a leaked
qBittorrent password.

### P1-3 · `TransferService` wiring is duplicated eight times — Done

`new TransferService({...})` appears in `src/server.ts:65,83,130,196`,
`src/admin/routes.ts:187,202,229` and `src/rss/poll.ts`, each re-listing
`downloads`, `backend`, `leaseDays`, `maxActiveDownloads`, `minFreeSpaceGB`,
`links` and `sourceResolver` by hand. They already differ in which optional
dependencies they pass, and a future field will be forgotten in at least one.

Extract one `transferServiceFor(settings, deps)` factory in the composition
root and call it from all eight sites.

### P1-4 · `createApp(deps?)` is optional-by-design and pays for it — Done

`deps` was optional even though every real caller (`src/index.ts` and every
test) always passed it, which forced non-null assertions through
`src/server.ts` (`deps!.config`, `deps!.downloads!`, `(await storeAccess)!`,
`assets.get(pathname)!`). `deps` is now a required `AppDeps` parameter;
`access`/`storeAccess`/`adminRoutes` are constructed unconditionally (they
already had fallback construction when the specific field was omitted, so
only the outer optionality was removed), and the addon-route closure that
built a `TransferService` now takes `downloads` as a parameter instead of
closing over the possibly-undefined `deps.downloads`. Every dependency-driven
`!` is gone; the only non-null assertions left in the file are
`request.url!` and regex capture groups after a successful match, which are
unrelated to this item. `deps.downloads`/`deps.access`/`deps.storeAccess`/
`deps.idempotency` stay individually optional — that's a real state (e.g.
`test/admin.test.ts`'s `withDownloads` toggle exercises the app with no
downloads repository), not incidental. No dedicated `buildTestApp()` helper
was added: every existing caller already passes a full deps object, and
`test/app-fixture.ts`'s `appFixture()` already serves as that helper for the
tests that want one.

### P1-5 · `handle()` in `src/server.ts` is a ~200-line if-chain — Done

Routing, CORS, CSP, health, assets, addon-key extraction and per-request
service construction were all inline in one function. Split into named
handlers (`handleStore`, `handleDav`, `handleDownloadLink`, `handleApiV1`,
`handleAdmin`, `handleAsset`, `handleReady`, `handleAddon`) dispatched from a
`{ match, handler }` table in the original if-chain order; `handle()` itself
now only sets the cross-cutting headers once, walks the table, and falls
through to the CORS-enabled generic surface (health checks, the Stremio
addon) exactly as before. No behaviour change — verified by the full test
suite (356 unit/integration + 4 Playwright) passing unmodified.

### P1-6 · `/health/ready` cannot detect the failures that actually happen — Done

It calls `deps.store.snapshot()` and `deps.downloads.list()`
(`src/server.ts:181-188`) — both served from in-memory caches. It returns
`ready` when the download client is unreachable, when `DOWNLOAD_DIR` is not
mounted, and when the database has become read-only. Those are precisely the
three failure modes the docs spend the most words on.

Add a cheap, cached (10–30 s) probe of the backend and a stat of
`DOWNLOAD_DIR`, and report a per-component object rather than a bare string,
so an orchestrator restarting on `/health/ready` restarts for real reasons.

### P1-7 · No request correlation, no metrics — Done

Added `requestId()` in `src/log.ts`: accepts a client-supplied `X-Request-Id`
if it matches a bounded, safe charset (so a hostile value can't inject a
newline into the log or grow a line unbounded), generates a UUID otherwise.
Every response echoes it as `X-Request-Id`; the access log line and both
generic error-body shapes (`src/server.ts`'s top-level catch, and
`sendApiError` for the native `/api/v1` surface) include it as `requestId`.

`GET /api/admin/metrics` (session auth) reports request totals by status
class (`src/metrics.ts`, a process-local counter — not Prometheus-format,
deliberately minimal), active playback count (`activeCount()`, new export on
`src/playback/active.ts`), search/stream admission slot usage
(`Admission.snapshot()`, new method), and a download count by lifecycle.
Documented in `docs/operations.md` under "Correlating a failure across
requests". This is deliberately scoped smaller than `ROADMAP.md`'s separate
`/capabilities` idea (`activeCount`/queued depth/free space on the *public*
API), which was not part of this operator-only audit item.

### P1-8 · The admin UI is one 1,461-line module with no unit tests — Done

`web/app.ts` holds settings, setup wizard, downloads dashboard, discovery
providers, saved searches and token management, with module-level mutable
state (`baseline`, `setupDirty`, `csrfToken`). The only automated coverage is
4 Playwright specs (`test/browser/`), which exercise configuration and
first-run setup — not the dashboard, not token revocation failure paths, not
the RSS rows.

Split by panel into modules with explicit state, and add DOM-level tests for
the pure parts (`parsePathMappings`, `formatSize`, `downloadSignature`,
`expiryText`, `downloadTags`) — they are already pure functions and need no
browser.

The setup wizard, dashboard download/cache controls, discovery-provider rows,
saved-search rows, and API-token controls now live in panel modules. Each
initializer owns its mutable request, polling, row, or wizard state. Shared DOM
helpers, response types, and pure presentation functions are separate modules.
Node-level unit tests cover the five pure functions without requiring a
browser; the existing Playwright specs continue to cover their DOM integration.

### P1-9 · Admin `api()` assumes every response is JSON — Done

`web/app.ts:144-156` does `await response.json()` before checking
`response.ok`. A 502/504 HTML page from a reverse proxy, a 413 from a body
limit, or any non-JSON error surfaces to the operator as
`Unexpected token '<'`. Check `content-type` and fall back to a status-derived
message.

### P1-10 · User-facing docs are missing for two shipped features — Done

Done. [docs/rss.md](docs/rss.md) and [docs/webhooks.md](docs/webhooks.md),
linked from the README help list and `docs/configuration.md`.

### P1-11 · No adversarial tests for the parsers that read hostile bytes — Done

Added the requested cases (truncated, deeply nested, oversized-length-prefix,
duplicate-key, non-UTF8) for bencode (`test/torrentFile.test.ts`) and the
feed parser (new `test/discovery-rss.test.ts`, since `src/discovery/rss.ts`
had no dedicated unit test before — only indirect coverage through the
Torznab client and RSS polling flow).

The fuzzing found a real bug, not just confirmed the parser was already
safe: `parseRssItems`'s `<item>...</item>` matcher
(`/<item>[\s\S]*?<\/item>/gi`) was quadratic on a feed with many `<item>`
openers and no closing tags — 50,000 unclosed tags took ~2.8s, scaling
roughly with the square of the count. At the `RSS_RESPONSE_BYTES` cap
(4 MiB), a single malicious or broken feed response could have blocked the
event loop — and every other request the whole process was serving — for
minutes. Rewrote it as a linear forward scan (`indexOfTag` in
`src/discovery/rss.ts`) that also respects `limit` directly instead of
matching the whole document first; same 50,000-tag case now takes ~15ms.
`nzbIdentity` and `isNzb` were checked and skipped: neither actually parses
anything (a byte hash and a bounded prefix check), so there's no adversarial
surface to fuzz. The DAV path resolver and zip writer were outside this
parser-focused item; their existing tests remain unchanged.

### P1-12 · Supply-chain and release-integrity gaps in CI — Done for 0.2.0

No dependency review or `npm audit` step, no CodeQL/SAST, no SBOM, no
Dependabot configuration (`.github/` contains only issue templates, a PR
template and `container.yml`), and image provenance is `mode=min` with no
signature. The project ships a container to GHCR for other people to run.

For 0.2.0: add `npm audit --audit-level=high` and a Dependabot config (cheap,
immediate), and decide explicitly on CodeQL, SBOM attestation and cosign
signing rather than leaving them unconsidered.

### P1-13 · Static assets are re-read from disk on every request, uncacheable — Done

`Cache-Control: no-store` was set for *every* response including
`/assets/app.js` and `/assets/style.css`, and the asset branch called
`readFile()` per request with no ETag. The three assets are now read once,
kicked off at `createApp()` time rather than per request, with a SHA-256
content ETag computed alongside. The asset handler now sets
`Cache-Control: no-cache` (always revalidate) plus the ETag, and answers
matching `If-None-Match` with a bodyless 304.

Scoped down from the original `public, max-age=31536000, immutable`
suggestion: that directive is only safe on a content-hashed URL, and these
paths (`/assets/app.js`, `/assets/style.css`, `/configure`) are fixed —
`web/index.html` references them by static path, and fingerprinting them
would mean touching the build pipeline to rewrite that reference too.
`immutable` on a fixed URL would tell browsers to keep serving last year's
bundle for up to a year after an upgrade without even checking. `no-cache`
still removes the per-request filesystem read and lets a 304 skip the body
on every unchanged load; hashed URLs with a long max-age is a separate,
larger follow-up if it's ever worth the build-pipeline change.

### P1-14 · Timeouts are scattered literals — Done

`AbortSignal.timeout(...)` appeared with 7 distinct hardcoded values
(8_000 ×7, 5_000 ×6, 15_000 ×3, 10_000 ×3, 90_000 ×2, 60_000 ×2, 30_000 ×1),
plus each integration client's own `test(timeoutMs = 10_000)` default and a
handful of already-named-but-scattered constants (`SEARCH_DEADLINE_MS`,
`DISCOVER_DEADLINE_MS`, `PREPARE_DEADLINE_MS`, `METADATA_WAIT_MS`,
`BUFFER_WAIT_MS`, `FEED_TIMEOUT_MS`, `REGISTER_TIMEOUT_MS`,
`METADATA_TIMEOUT_MS`). All of it now lives in `src/timeouts.ts` as named
exports, one per distinct call-site purpose, with a comment on each pointing
at what it bounds — pure rename/relocate, no numeric value changed.

The two that matter on slow hardware are now genuinely operator-tunable:
`DEBRIDARR_METADATA_WAIT_MS` and `DEBRIDARR_BUFFER_WAIT_MS` (see
`docs/configuration.md`), parsed and validated in `src/config.ts` the same
way `PORT` is, and threaded through `Config` into `playback/index.ts`'s
`handlePlay` (which already had a test-only `readyWaitMs` override — that
still wins when set). `src/jobs/runner.ts`'s interval/backoff constants were
deliberately left alone: they're already named and scoped to that one file,
not the raw-literal-scatter problem this item was about.

---

## P2 — worth doing, not release-blocking

- **`addon_references` never prunes expired rows.** Done: `pruneExpired` on
  both drivers, called from the hourly sweep. Reads still filter on
  `expires_at`; this only reclaims the dead rows.
- **No `VACUUM` / `PRAGMA optimize`.** Done: SQLite uses incremental
  auto-vacuum, runs `PRAGMA optimize` plus a bounded incremental vacuum hourly
  and at clean shutdown, and converts an existing database once on first open.
- **Linux-only playback is under-documented for contributors.** Done:
  `CONTRIBUTING.md` now states the constraint and points at running the full
  suite in a Linux VM/container instead of hitting it as an unexplained test
  failure.
- **Multi-instance is unsupported but not enforced.** Done: `openState()`
  takes an exclusive `.debridarr.lock` in `DATA_DIR`, refuses a second live
  process, recovers a stale owner, and releases only its own lock on close.
- **`src/settings.ts` is 741 lines** holding the type, defaults, patch
  validation, seeding, redaction, serialisation and every migration. Done:
  schema history and migration parsing now live in `src/settings-migrations.ts`.
- **`SqliteDownloadsStore.list()` re-normalises and re-sorts the whole map on
  every call.** Done: the sorted array is now cached and only recomputed
  after a write (`upsert`/`remove`/`renew`/`setKept` all invalidate it).
  Records are still cloned (`normalize()`) on every `list()`/`get()` call —
  that's deliberate, not part of this fix — so callers can't mutate the
  cached state through the returned objects.
- **No automated accessibility check.** Done: Playwright runs axe against the
  login page, dashboard, and every settings tab, failing on serious or critical
  WCAG 2.0/2.1 A/AA violations.
- **English-only, strings inline in `web/app.ts` and in server error
  messages.** Decided: 0.x remains English-only. `CONTRIBUTING.md` records the
  extraction boundary and requires a second maintained locale before adding an
  i18n framework.

---

## By area

| Area | State | Main gap |
| --- | --- | --- |
| Build / tooling | Lint, typecheck, coverage floor, Node 24/current matrix | None from this audit |
| CI / release | `dev`/`main` CI, pinned actions/digests, audit, Dependabot, release tag check | Create the annotated tag from the merged release commit |
| Container | Non-root, digest-pinned, healthcheck, read-only download mount | None blocking |
| Security | Documented trust model, trusted-proxy parsing, scrypt, CSRF, confinement, scopes | Secret encryption deferred with rationale in `SECURITY.md` |
| State layer | Migrated SQLite plus durable JSON repositories under one restart-tested contract | None from this audit |
| Core server | Dependency-driven routing, cached readiness probes, cacheable assets, request correlation and metrics | None from this audit |
| Application seam | Backend-neutral with one transfer-service factory | None from this audit |
| Backends | 4 clients behind one capability contract, contract-tested | None from this audit |
| Playback | Careful confinement, range + piece gating, Linux requirement documented | None from this audit |
| API v1 / adapters | Scopes, durable idempotency, cursors, OpenAPI, error codes | None from this audit |
| Frontend | Panel modules, pure-helper unit coverage, robust errors, automated axe checks | English-only during 0.x by documented decision |
| Tests | Coverage-gated unit/integration suite, parser adversarial cases, five browser specs | None from this audit |
| Docs | Operations, release, RSS, webhook, compatibility, API, and configuration guides | None from this audit |

---

## Suggested order

1. **P0-3** (CI on `dev`) — everything after this is verified automatically.
2. **P0-4**, **P0-5** (lint + coverage) — land the mechanical churn before
   feature work.
3. **P0-1** (migrations) — must exist before any 0.2.0 schema change.
4. **P0-6**, **P0-7** (driver durability, Node range) — small, self-contained.
5. **P1-1**, **P1-2** (proxy identity, secrets at rest) — the two items a
   security-minded user will raise first.
6. **P1-3 → P1-5** (wiring, deps, router) — one refactor pass.
7. **P1-10**, **P1-6**, **P1-7** (docs, readiness, correlation) — release
   polish.
8. **P0-2** (version, changelog, tag check) — last, as part of cutting the tag.

## Definition of done for 0.2.0

- [x] `npm run lint`, `npm run typecheck`, `npm test` (with coverage), and
      `npm run test:e2e` all run in CI on `dev` and `main`.
- [x] An install created by 0.1.x opens under 0.2.0, migrates, and starts —
      proven by a test with a v1 database fixture, not by hand.
- [x] 0.2.0 refuses to start against a database written by a newer build.
- [x] Both state drivers pass the same durability contract, or the JSON driver
      is documented as migration-only and refuses the paths it cannot support.
- [x] Every shipped feature has a page under `docs/` (RSS and webhooks are the
      two missing).
- [x] `docs/operations.md` states that a data-directory backup contains
      service credentials.
- [ ] `package.json`, `CHANGELOG.md`, `docs/compatibility.md` and the release-tag
      check all say 0.2.0. The final release action is to create the git tag
      from the merged release commit.
- [x] `npm audit` clean and a Dependabot config in place.

---

## Progress log

Worked in the suggested order on branch `dev`. Each entry was verified with
`npm run lint`, `npm run typecheck`, `npm run test:coverage` and, where the UI
was touched, `npx playwright test` before it was committed.

| Item | Commit | State |
| --- | --- | --- |
| P0-3, P0-4, P0-5, P0-7, P1-12 | `43d1b57` | Done |
| P0-1 SQLite migration runner | `dc6fb26` | Done |
| P0-6 JSON jobs and idempotency durability | this branch | Done |
| P1-1 Trusted proxy / X-Forwarded-For | `0f75076` | Done |
| P1-3 TransferService factory | `c430221` | Done |
| P1-9 Admin UI error reporting | `009ed7c` | Done |
| P1-10 RSS and webhook docs | `b277286` | Done |
| P2 prune expired `addon_references` on sweep | `b277286` | Done |
| P1-2 Secrets-at-rest documented as plaintext | `2703d85` | Done |
| P1-6 `/health/ready` checks backend + `DOWNLOAD_DIR` | `2703d85` | Done |
| P1-4 `createApp(deps)` required, dependency-driven `!` removed | `234fb26` | Done |
| P1-5 `handle()` routes via a `{ match, handler }` table | `234fb26` | Done |
| P1-13 Cacheable static assets (ETag + no-cache) | `da2739d` | Done |
| P1-14 Timeouts centralised in `src/timeouts.ts`, two made operator-tunable | `da2739d` | Done |
| P2 `SqliteDownloadsStore.list()` caches its sorted view | `da2739d` | Done |
| P2 Linux-only playback documented in `CONTRIBUTING.md` | `da2739d` | Done |
| P1-11 Adversarial tests for bencode and the feed parser; fixed a quadratic-time bug the fuzzing found | this branch | Done |
| P1-7 Request correlation id + `/api/admin/metrics` | this branch | Done |
| P1-8 Admin UI split into panel modules with pure-helper unit tests | this branch | Done |
| P0-2 0.2.0 version, changelog, release guide and tag check | this branch | Done; tag creation is the release action |
| P2 SQLite optimize and incremental vacuum | this branch | Done |
| P2 single-process data-directory lock | this branch | Done |
| P2 settings migration module split | this branch | Done |
| P2 automated axe accessibility checks | this branch | Done |
| P2 English-only 0.x decision | this branch | Done |
| P1-2 secret-encryption decision | this branch | Deferred with rationale in `SECURITY.md` |
| P1-12 CodeQL/SBOM/signing decision | this branch | Deferred with revisit criteria in `SECURITY.md` |

Final verification on 2026-09-12:

| Check | Result |
| --- | --- |
| `npm run lint` | Clean |
| `npm run typecheck` | Clean |
| `npm run test:coverage` | 382 passed; 97.18% lines, 86.13% branches, 93.96% functions |
| `npm run test:e2e` | 5 passed, including the axe accessibility scan |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm run check:release -- v0.2.0` | Passed; a mismatched tag is rejected |

No implementation jobs from this audit remain. Publishing 0.2.0 still requires
merging the release commit and creating/pushing its annotated `v0.2.0` tag, as
documented in `docs/releasing.md`. Secret-field encryption and the larger
CodeQL/SBOM/signing additions are explicitly deferred in `SECURITY.md`, with
rationale and revisit criteria rather than being left undecided.
