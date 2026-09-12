# Contributing

Debridarr focuses on torrent intake, qBittorrent downloads, Stremio playback,
and cache management. Describe the user problem before proposing new services
or dependencies. Keep changes small and reuse the existing lifecycle code.
Upcoming work is sliced in [ROADMAP.md](ROADMAP.md); take one independently
verifiable slice at a time.

Use Node.js 24 and `npm ci`. Run `npm run typecheck`, `npm test`, and
`npm run test:e2e` for relevant changes. The browser command includes a production
build. Tests must use local fixtures, not real tracker accounts or personal media.

Playback file access (`src/playback/paths.ts`) is Linux-only by design — it
walks the confined path descriptor-by-descriptor with `O_NOFOLLOW`, which has
no portable equivalent. On macOS or Windows, anything that opens a file for
playback throws `Secure file access requires Linux` instead of skipping;
develop and run the full suite in a Linux VM or container (the project's own
`Dockerfile` works) if you're not already on Linux.

Extend existing integration scenarios where possible. Add focused coverage for
new failure modes, especially ownership, file confinement, recovery and deletion.
Avoid testing constants or duplicating the same service flow in another mock suite.

Do not commit `.env`, state files, credentials, private addon links, or personal
deployment details. Redact logs and screenshots before attaching them. Report
security issues using [SECURITY.md](SECURITY.md).

Pull requests should explain the resulting behavior and the checks performed.
Include upgrade/migration notes for persisted-data changes. `private: true` in
package.json prevents accidental npm publication; GitHub visibility is separate.

The administration UI and server messages are English-only for the 0.x line.
Keep new user-facing strings in the panel or service that owns them and write
plain text that can later become a translation key. Do not introduce an i18n
framework until a second maintained locale has a contributor; at that point,
extract all strings in one pass so the source language and fallback behavior
stay consistent.

Maintainers cut releases using [docs/releasing.md](docs/releasing.md). Release
preparation belongs in a dedicated commit; never reuse or move a published tag.

## Contribution terms

By submitting code, documentation, artwork, or another contribution to this
repository, you represent that you have the right to submit it and agree to the
following terms. You retain ownership of your contribution.

You grant Brcly a perpetual, worldwide, irrevocable, non-exclusive, transferable,
royalty-free license to use, reproduce, modify, prepare derivative works from,
publicly display, publicly perform, distribute, sublicense, and relicense your
contribution, including as part of paid or proprietary versions of Debridarr.
You also grant Brcly and users of Debridarr a perpetual, worldwide, royalty-free
patent license for patent claims you can license that are necessarily infringed
by your contribution or its combination with Debridarr.

Identify any third-party material and its license in your pull request. A
submission does not require Brcly to accept, use, or pay for the contribution.
Development forks and contributions remain subject to [LICENSE.md](LICENSE.md).
