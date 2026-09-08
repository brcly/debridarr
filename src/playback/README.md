# HTTP playback

Serves the file for a selected release to Stremio.

- `index.ts` — `handlePlay(request, response, token)`: decode the token, call
  `ensureDownload` (deduping concurrent hits for the same torrent, sourcing the
  lease length and ratio limit from `retention` settings), wait a few seconds
  for a nearly-complete file, renew the lease if `retention.extendOnPlay` is
  on, then stream it. While the wanted file is still downloading it answers
  `503 {status:'downloading', progress}`; an unconfigured qBittorrent is `503`;
  a file Debridarr cannot see on disk is `502 {code:'not_mounted'}`.
- `active.ts` — a refcounted registry (`markActive`/`markInactive`/`isActive`)
  of infohashes currently being streamed. `handlePlay` marks a hash active for
  the duration of `serveFile`; the retention sweeper checks it and never
  deletes a title mid-stream.
- `paths.ts` — `resolveLocalFile()` maps qBittorrent's save path + file name to a
  path under `DOWNLOAD_DIR`, trying the path as-is (same mount in both
  containers) then `DOWNLOAD_DIR + relative name` (Debridarr mounts it there),
  and refuses anything that climbs outside `DOWNLOAD_DIR`.
- `serve.ts` — `serveFile()`: HTTP range support (`206`, `Content-Range`,
  `416`), `HEAD`, and a content type from the extension.

Current limitation: a file is served only once fully downloaded. Partial-file /
while-downloading streaming and a configurable path-prefix remap are still to
come.
