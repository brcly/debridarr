# OpenMediaVault

Use this example with the OMV Compose plugin. It references OMV macros, so it
is not directly usable by ordinary Docker Compose until those macros expand.
For a standard Docker installation, use the root [Compose file](../../compose.yaml).

1. Adapt the `appuser`, `users`, `appdata` and `data` macro names to your server.
2. Create `appdata/debridarr/config`, owned by the chosen container user/group
   with mode `0700`. Retain all existing state when upgrading an installation.
3. Point the download bind at the host tree containing qBittorrent's complete
   and incomplete files. The container user needs read/traverse permissions.
4. Set `APP_URL` and `ADMIN_PASSWORD` in the Environment tab using the example.
5. Start Debridarr, open `APP_URL`, and use the setup guide. Enter service
   addresses reachable from the container; host addresses with published ports
   work. Container names require a shared Docker network.
6. Run Playback readiness after a torrent has downloaded data to verify the mount.

If qBittorrent runs behind a VPN container, its Web UI may be reachable through
that container's published port or its name on a shared Docker network. Do not
assume that `localhost` inside Debridarr reaches another container.

For a reverse proxy, use the HTTPS origin as `APP_URL` and forward to port 7000.
Preserve range requests, allow long streaming responses, and disable response
buffering. The proxy and Debridarr need a shared network to use a service name.

See [configuration](../../docs/configuration.md) and
[backup and recovery](../../docs/operations.md). This example requires no
changes to qBittorrent's global settings and mounts downloads read-only.
