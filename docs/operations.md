# Upgrades, backups and recovery

Keep the Compose file and `.env` with your deployment. Treat the administrator
password and data-volume backups as secrets. The volume contains service
credentials, addon access, download ownership and hashed API-token definitions.

## Reverse-proxy logs

The Stremio installation URL is `/addon/<key>/manifest.json`. The key is a
bearer capability: anyone who has it can search and start playback. Do not
write `/addon/` paths to access logs.

nginx example — log a redacted path instead of the raw URI:

```nginx
map $uri $debridarr_log_uri {
    ~*^/addon/[^/]+(/.*)$  /addon/[redacted]$1;
    default                $uri;
}
log_format debridarr '$remote_addr $status $debridarr_log_uri';
access_log /var/log/nginx/debridarr.access.log debridarr;
```

gzip JSON addon and API responses at the proxy. Do not gzip video
(`/api/v1/download/`, `/addon/.../play/`). Debridarr already sends
`X-Accel-Buffering: no` so nginx does not buffer playback.

```nginx
gzip on;
gzip_types application/json application/javascript text/css text/html;
```

## Back up

Stop Debridarr so all state files form one consistent snapshot; qBittorrent can
continue running. For the root Compose named-volume installation:

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose stop debridarr
docker compose run --rm --no-deps -T --entrypoint tar debridarr -C /app/data -czf - . > backups/debridarr-data.tar.gz
docker compose start debridarr
```

Check the backup command succeeded before treating the archive as usable. Keep
previous backups separately rather than overwriting your only good copy. The
archive covers Debridarr state; it does not include downloaded media or qBittorrent
configuration. Back those up separately if required. Save the Compose and `.env`
files privately as well.

**The archive is a plaintext credential dump.** The download-client password,
every discovery-provider API key, the TMDB key and the webhook signing secret
are stored unencrypted in Debridarr's state (protected only by filesystem
permissions on the data directory). Anyone who can read
`backups/debridarr-data.tar.gz` has all of them. Store backups with the same
care as the `.env` file: encrypt them at rest, restrict who can read them, and
never attach one to a support request or public issue.

## Upgrade

1. Read the target release notes and take a backup.
2. Set `DEBRIDARR_IMAGE` to the published release tag you want.
3. Run `docker compose pull` followed by `docker compose up -d`.
4. Check `/health` (process up) and `/health/ready` (state, backend, and download
   directory available). Sign in and run Playback readiness. Confirm existing
   downloads and your private addon link remain available.

`GET /health` is liveness only: Docker `HEALTHCHECK` uses it so a wedged
qBittorrent does not restart the container. `GET /health/ready` returns 200
`{status:"ready",checks:{...}}` after checking the settings and download stores,
the configured download backend, and `DOWNLOAD_DIR`. It returns 503 with the
failed components marked `error`. Results are cached for 15 seconds. Use
`/health/ready` from Compose or a reverse proxy when you want to wait until
Debridarr can accept transfers, not as the container liveness probe.

## State ownership and maintenance

Debridarr permits one running process per `DATA_DIR`. Startup creates
`.debridarr.lock` and refuses a second live owner; a lock left by a process that
no longer exists is recovered automatically. Do not share one data directory
between containers or hosts.

SQLite databases use incremental auto-vacuum. Debridarr runs `PRAGMA optimize`
and a bounded incremental vacuum during the hourly maintenance job and again at
clean shutdown. The first 0.2.0 start of an older database performs one full
`VACUUM` to enable incremental mode, so allow extra startup time and temporary
free space roughly equal to the database size. Back up the data directory
before upgrading.

Set `LOG_LEVEL=info` (default) for one JSON request line per call, with
`/addon/`, `/play/`, and `/api/v1/download/` secrets redacted. `/health` is
omitted. Use `warn` or `error` to quiet the log, `debug` for the same request
line plus extra client traces.

Schema migrations retain existing settings and ownership. Version 10 adds a
minimum-free-space setting, disabled for upgraded installations and defaulting
to 1 GB for new installs. Configure it in Library after reviewing your storage.

Version 15 moves content preferences onto each discovery provider and folds the
old single-Prowlarr setting into the provider list. Nothing is lost: a legacy
Prowlarr URL and key become one Prowlarr provider row, and the previous
instance-wide resolution/codec/language filters become the starting values for
every existing provider. Review them per row in Connections, because a provider
now keeps its own filters instead of sharing one global set. Because playback
references are scoped to the provider list, existing prepared links and Stremio
playback selections are invalidated once at upgrade; reopen the title to mint a
current one. Existing downloads, ownership and API tokens are unaffected.

## Restore or roll back

Stop Debridarr before restoring. Use the image version matching the backup and
restore into a fresh data volume or an empty bind-mounted data directory. For
a Compose volume, temporarily change its volume name in Compose to create a
separate restore target; retain the original volume until verification finishes.

```sh
docker compose stop debridarr
# Select the matching image and fresh data volume in Compose first.
docker compose run --rm --no-deps -T --entrypoint tar debridarr -C /app/data -xzf - < backups/debridarr-data.tar.gz
docker compose up -d
```

The container user must own the restored state and retain read access to the
download mount. Verify health, login, downloads and playback. Restore all state
files together; deleting `downloads.json` to bypass a conflict loses ownership
tracking. Restoring an old token snapshot can revive tokens revoked afterward;
review and revoke those tokens again.

Do not simply run an older image against data migrated by a newer release.
A rollback requires the earlier image and its matching pre-upgrade backup.

## Recovery controls

The dashboard refreshes while visible. **Retry** performs a short preparation
attempt for pending or recoverable downloads. Automatic recovery runs every
15 seconds, processes at most two items per tick, and backs off individual items
up to five minutes. An absent pending registration remains tracked for operator
review; recovery never recreates it with incomplete source information. Hourly
cleanup can remove stale managed records after confirming the torrent is absent.

**Files** lists playable store files and lets you select additional videos.
Selections preserve earlier files and do not renew retention until playback.
**Keep** protects against automatic cleanup; **Release** restores the normal
policy. Explicit Delete removes files even for a kept title, but refuses active
playback and retains tracking until qBittorrent confirms absence.

## Correlating a failure across requests

Every response carries an `X-Request-Id` header — echoed back if the caller
(or a reverse proxy) sets one, generated otherwise — and every JSON error
body includes the same value as `requestId`. Each access log line also
includes it. To trace a reported failure: take the `requestId` from the
error response or from the client's network tab, then `grep` the logs for it
to find the exact request, its status, and timing.

`GET /api/admin/metrics` (session auth, same as the rest of `/api/admin/`)
returns process-local counters for a quick health check without log-diving:
request totals by status class, active playback count, search/stream
admission slot usage, and a download count by lifecycle. It resets on
restart and is a debugging aid, not a durable metrics store — there is no
Prometheus-format export.
