# Debridarr on your OMV 8 server

This setup follows `brclys-OMV-compose-files`: OMV shared-folder/user substitutions,
`appuser:users`, and the existing `internal_bridge` network. It is a separate
Compose entry; Gluetun, qBittorrent, Prowlarr and NGINX Proxy Manager keep their
existing stacks.

| Item | Configuration |
| --- | --- |
| Server | `10.0.0.10` |
| Image | `DEBRIDARR_IMAGE` from your GitHub Container Registry package |
| Saved settings, addon key and download records | `${{ sf:"appdata" }}/debridarr/config` → `/app/data` |
| Torrent files | `${{ sf:"data" }}/torrents` → `/data/torrents`, read-only |
| Container user | `${{ uid:"appuser" }}:${{ gid:"users" }}` |
| Service/proxy network | Existing `internal_bridge` |
| Prowlarr | `http://gluetun:9696` |
| qBittorrent | `http://gluetun:8080` |
| NGINX Proxy Manager upstream | `http://debridarr:7000` |
| Planned public URL | `https://debridarr.nexusvau.lt` |

OMV expands `${{ ... }}` expressions before running Docker Compose. Paste this
YAML through the OMV plugin rather than passing it directly to the Docker CLI.
The substitutions are documented in the
[OMV 8 guide](https://wiki.omv-extras.org/doku.php?id=omv8:docker_in_omv).

## 1. Publish the image on GitHub

Create the GitHub repository, commit the current project changes (including
`.github/workflows/container.yml` and new security files), and push `main`.
The **Test and publish container** workflow checks types, unit/integration tests,
browser behavior and production-container startup before publishing AMD64 and
ARM64 images to `ghcr.io/<owner>/<repository>` (all lowercase).

The workflow uses GitHub's built-in GITHUB_TOKEN with package-write permission;
no publishing token needs to be added to repository secrets. A successful main
build produces `latest`, `main` and `sha-<full-commit>` tags. Version tags such
as `v0.1.0` produce `v0.1.0`, `0.1.0` and a commit tag; they do not replace
`latest`, which follows tested main builds. Pull requests run checks without
publishing. You can also rerun publishing from Actions using workflow dispatch
on main or a version tag.

After the first successful workflow, set the container package's visibility to
**Public** in its GitHub package settings if you want OMV to pull without a
registry login. New GHCR packages default to private, even when the source
repository is public. If keeping the package private, authenticate Docker on
OMV to ghcr.io with a GitHub classic personal access token granting
`read:packages`, using the same user/credential context as OMV Compose. See
[GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Set DEBRIDARR_IMAGE in the OMV Environment tab to the resulting image, for example
`ghcr.io/brcly/debridarr:latest` (assuming the repository is `brcly/debridarr`). Once that image exists and is
accessible, the server can pull it directly; no source archive or build tools
are required on OMV.

## 2. Prepare the configuration folder

Create `debridarr/config` inside your existing `appdata` shared folder, owned by
`appuser:users` with mode `0700`. In an OMV terminal, substitute the actual
absolute path shown for your appdata shared folder:

```sh
sudo install -d -m 0700 -o appuser -g users /absolute/path/to/appdata/debridarr/config
```

The Compose file requires both bind source directories to exist, so an incorrect
path will not silently create an empty root-owned directory. Debridarr runs as
appuser and must be able to write its own config directory. It reads torrent
files using the same UID/group convention as your qBittorrent container. This
image uses the Compose `user` field; PUID/PGID environment variables do not
change its user.

This is the layout for your new OMV installation. If you already ran the earlier
named-volume template, keep that volume mounted at `/app/data`, or stop the app
and migrate its contents and ownership to this folder first. Preserve all three
JSON files together: settings.json, downloads.json and addon.json.

## 3. Add the OMV Compose entry

Under **Services → Compose → Files**, create an entry named `debridarr`.

- Paste the supplied YAML into the File editor (`debridarr.yaml` in your OMV
  Compose repository, or `compose.yaml` in the addon's `deploy/omv` directory).
- Paste `debridarr.env.example` into the Environment editor; set DEBRIDARR_IMAGE
  and a password.
- Leave `APP_URL=http://10.0.0.10:7000` until the HTTPS proxy works. If port 7000
  is occupied, change DEBRIDARR_PORT and the port in the LAN APP_URL together.
- Save, check the file in OMV, then use **Pull** followed by **Up**.

The app joins its default network for ordinary outbound access and
`internal_bridge` for Gluetun and NGINX Proxy Manager. It has its own network
namespace; its traffic is not routed through Gluetun. qBittorrent and Prowlarr
remain in Gluetun's existing namespace.

Open `http://10.0.0.10:7000/health`, then
`http://10.0.0.10:7000/configure`. Enter the Prowlarr API key and qBittorrent
username/password under Connections, test both services, and save. The URLs are
seeded on first startup; later changes use the website rather than environment
variables.

If Gluetun blocks these connections despite correct DNS, check its existing
input rules for ports 9696 and 8080. Its
[FIREWALL_INPUT_PORTS setting](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/firewall.md)
controls default-interface access. Preserve existing allowed ports when
adjusting it.

## 4. Set up NGINX Proxy Manager

Your NGINX Proxy Manager already joins `internal_bridge`, so configure a Proxy
Host using:

| NPM field | Value |
| --- | --- |
| Domain Names | `debridarr.nexusvau.lt` |
| Scheme | `http` |
| Forward Hostname / IP | `debridarr` |
| Forward Port | `7000` |
| Cache Assets | Off |
| SSL | A valid certificate for the domain; Force SSL enabled |

Use your existing DNS approach for NPM at `10.0.0.80`. The upstream is the Docker
hostname on the shared bridge. Leave the original Host header intact: Debridarr
checks it against APP_URL. NPM's default proxy configuration already forwards
that header. Range headers and partial-content responses must pass through;
keep proxy caching disabled and avoid logging `/addon/` paths because they
contain the private installation key.

Once DNS/TLS work, set `APP_URL=https://debridarr.nexusvau.lt` in the Environment
editor and recreate Debridarr using Up. Open
`https://debridarr.nexusvau.lt/configure`, sign in again and install its private
HTTPS addon URL from Dashboard. After this change, administration must use the
HTTPS hostname; health checks on the LAN address still work.

## Updating and first playback

Push changes to GitHub and wait for the publishing workflow to succeed. In OMV,
use Pull followed by Up to recreate the app from the updated image. The template
also checks the registry on Up using `pull_policy: always`. For a fixed version,
set DEBRIDARR_IMAGE to a version tag or `@sha256:…` digest instead of latest.
Retain the config directory and its ownership so settings, addon access and
download tracking survive replacement. Include it in your appdata backups.

For the first playback test, choose a controlled torrent which isn't already
owned by SeedStrem, Radarr or Sonarr. Debridarr refuses unrelated existing
torrents. The selected file must finish downloading before playback starts;
retry when ready. Downloads mount at the same `/data/torrents` path reported by
qBittorrent, including any nested save directories.

The publishing workflow and deployment files have been prepared locally. The
first GitHub workflow run must complete before this image can be pulled. No
image has been published or running OMV containers changed by the agent.
