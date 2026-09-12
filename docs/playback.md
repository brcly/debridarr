# Playback troubleshooting

Start with Dashboard → Check playback readiness. It separately checks the Web
API connection, directory access, a real torrent file, and qBittorrent free space.
On an empty installation, file access remains unverified until data is available.

Incomplete selected files play a short downloading status clip by default. This
keeps the Stremio experience predictable while qBittorrent finishes the file.
Library → Playback can opt into experimental streaming while downloading. In
that mode, Debridarr reads only verified pieces, but playback can still stall or
fail when the player seeks ahead, peers are slow, or the media container needs
data that has not arrived. Completed files play normally regardless of this
setting.

- **Connection fails:** use a service URL reachable inside the container, with
  the correct port/base path. Verify the Web UI credentials and proxy rules.
- **Connected but file access fails:** mount qBittorrent's complete and incomplete
  trees. Use matching internal paths where possible and verify read/traverse
  permissions for the container user. Read-only mounts work; symlinks do not.
- **Pending metadata:** peer discovery may take time. Recovery retries automatically;
  the dashboard also offers Retry. Check the torrent in qBittorrent if it persists.
- **Low space / unknown space:** free space, fix qBittorrent connectivity, or adjust
  the minimum-free-space setting. The guard uses qBittorrent's default filesystem.
- **Experimental partial-playback buffering:** peer throughput and server upload
  speed must exceed the video bitrate. Seeking ahead can wait for missing pieces.
  Disable streaming while downloading for the reliable status-clip behavior.
  Debridarr does not transcode.
- **Ownership conflict:** restore the original client/category/tag configuration.
  Do not delete the local tracking file or retag unrelated torrents to bypass it.

Set `APP_URL` to the exact public origin used by your browser and Stremio. The
admin site validates this origin, and generated playback links use it. Behind
an HTTPS reverse proxy, forward to Debridarr's internal HTTP port, preserve Range
and Content-Range headers, allow long reads, and disable response buffering.
Keep private addon URLs and store tokens out of public logs and issue reports.

The administration connection-test endpoints intentionally let the authenticated
administrator test arbitrary discovery-provider and download-backend addresses. Treat an admin
session as full local-network access. Login failures and Store API failures are
throttled by the connection's socket address; behind a reverse proxy, forwarded
client-IP headers are deliberately ignored, so clients behind that proxy share
the throttle.

`/health` is a public liveness check; it does not promise that upstream services,
mounts, media codecs or remote playback-device connectivity are working.
`/health/ready` confirms the settings and download stores load. Neither endpoint
calls the download backend.
