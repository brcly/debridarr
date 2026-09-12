# Security reporting

Use this repository's **Security → Report a vulnerability** page for private
reports. If that option is unavailable, open an issue requesting a private
reporting channel without publishing exploit details or credentials.

Include the affected version, deployment layout, reproduction steps with fixture
data, impact, and any suggested fix. Never send your live `.env`, data volume,
service keys, private addon manifest URL, or unredacted playback links.

Debridarr is preparing its first public beta. Fixes target the current beta line;
older experimental/private builds have no separate maintenance commitment.

Run one instance per data directory. Keep addon links and API tokens private,
use a password for administration, and mount downloads read-only. Tokens access
one shared library and do not provide tenant isolation. See the README for
supported deployment constraints and the operations guide for backup handling.

## Trust model and accepted risks

Debridarr is single-operator software. Sessions and rate limiting are
process-local. An exclusive lock in `DATA_DIR` refuses a second live process;
multiple replicas with separate data directories remain unsupported.

- **The administrator is fully trusted.** A signed-in admin sets the
  discovery-provider and qBittorrent URLs and can run connection tests against
  them. Because those services normally live on private addresses, Debridarr
  does not restrict which address a test or a configured integration may reach.
  An admin can therefore use it to probe whether an internal host/port is
  reachable. Connection tests
  only ever return a fixed status plus a version-shaped string — no response body
  is reflected — and every settings and test route requires the session cookie, a
  matching `Origin`, and a CSRF token.
- **Store API tokens are full store credentials.** A valid token can add torrents
  to your qBittorrent, mint playback links, list the library, and delete
  store-origin torrents (with their files). It cannot touch search-origin
  downloads. Tokens are opt-in (none exist until you create one), hashed at rest,
  revocable, and bounded by per-token rate and concurrency quotas plus the
  minimum-free-space and active-download limits. Treat a token like a password.
- **The installation key is a bearer capability.** Anyone with the
  `/addon/<key>/` URL can search, list the library, and start/stream playback.
  Rotate it from the dashboard if it leaks; that invalidates every issued
  playback link.
- **Abuse limits key on the TCP source address unless you configure trusted
  proxies.** By default `X-Forwarded-For` is ignored, because a direct caller
  can forge it and mint a fresh identity per request. The cost is that behind a
  reverse proxy every client shares the proxy's address, so five failed admin
  logins (or store-token auth failures) can lock out the real client for
  15 minutes, and the stream/playback admission slots are shared globally.

  Set `TRUSTED_PROXIES` (see `docs/configuration.md`) to the address, CIDR range,
  or `loopback`/`private` shorthand your proxy connects from. The header is then
  honoured *only* on connections from those peers, and the identity used is the
  right-most address in the chain that is not itself trusted — the last hop your
  trusted proxies actually observed. Set it no wider than your real proxy: any
  peer you trust can choose its own identity, and so can anything that can reach
  Debridarr from inside that range.
- **Integration secrets are stored in plaintext.** The download-client
  password, every discovery-provider API key, the TMDB key and the webhook
  signing secret are held unencrypted in the state directory, protected only
  by filesystem permissions (`0600`/`0700`). A copy of the data directory —
  including a backup tarball — is a plaintext credential dump. See
  `docs/operations.md` for how to handle backups accordingly.
  Encryption is deliberately deferred for 0.2.0: a key stored in `DATA_DIR`
  would also be present in its backup and provide no protection, while an
  external key would add a mandatory recovery secret that existing operators
  do not have. A future encrypted format must define key provisioning,
  rotation, loss recovery, and migration together.
- **Serve HTTPS off-host.** The app listens on plain HTTP on `0.0.0.0`. Put a
  TLS-terminating reverse proxy in front for anything reachable beyond the
  Docker host, set `APP_URL` to that public origin, and keep `/addon/` paths out
  of the proxy's access logs (they contain the installation key).

## Supply-chain posture

CI runs a high-severity npm audit, Dependabot covers npm, Actions and the base
image, Actions are commit-pinned, and the container base is digest-pinned.
The 0.2.0 image uses GitHub Actions' minimum provenance metadata. CodeQL, a
published SBOM, and cosign signatures are deferred until the project adds
runtime dependencies or promotes a stable release: today they would add
release credentials and policy without improving the zero-runtime-dependency
artifact enough to justify that maintenance. Revisit all three together before
1.0 or when the runtime dependency surface changes, whichever comes first.
