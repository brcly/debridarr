# WebDAV (`/dav/`)

A read-only WebDAV tree of your library, for clients that consume a network
share instead of the Stremio addon — Infuse, VLC, Jellyfin (as a library
source), and `rclone mount`. Available in **Store** and **Both** modes only;
Search mode has no `/dav/` surface (`404`, checked before authentication).

## Connecting

WebDAV clients are native apps, not browsers — they authenticate with HTTP
Basic, not a bearer header. Create a token on Dashboard → **API tokens** with
at least the **read** and **link** scopes (new tokens hold all three by
default), then connect with:

- **Server**: `${APP_URL}/dav/`
- **Username**: anything — it is not checked
- **Password**: the token

A client that can set a custom `Authorization: Bearer <token>` header (for
example `rclone --webdav-headers`) may use that instead of Basic.

```sh
curl -u "x:$TOKEN" -X PROPFIND -H 'Depth: 1' "$APP_URL/dav/"
```

## Tree

```
/dav/
  <transfer name>/
    <file path>
    <subfolder>/
      <file path>
```

Each top-level folder is one managed transfer, named after it (disambiguated
with a short id suffix only if two transfers would otherwise collide). Inside,
the tree mirrors each file's path in the torrent or NZB. Only files that are
**both selected and fully downloaded** appear — an unselected extra, a
still-downloading piece-gated file, and anything not a recognized video are
never listed, matching the "no incomplete files" rule the API and dashboard
already follow. A transfer with nothing eligible yet still exists as an empty
folder rather than disappearing from the root.

File access is confined to `DOWNLOAD_DIR` through the same path mapping and
traversal checks as the Stremio addon and native API use to open the same
files — nothing this mount serves lives outside that root.

## Methods

`OPTIONS`, `PROPFIND`, `GET`, and `HEAD` only. `GET` supports HTTP `Range` for
seeking. `PROPFIND` always returns a fixed, broadly-useful property set
(`displayname`, `resourcetype`, `getcontentlength`, `getcontenttype`,
`getlastmodified`) rather than negotiating the client's requested properties;
every real client tolerates this. `Depth: infinity` is rejected with `403`
— walk one level at a time, the same way `Depth: 0`/`1` already work.

Every write method — `PUT`, `DELETE`, `MOVE`, `MKCOL`, `PROPPATCH`, `COPY`,
`LOCK`, `UNLOCK` — answers `405`. There is no partial or write access to a
transfer's files from this mount.

## Errors

Not part of the OpenAPI document (WebDAV predates it); status codes follow the
same shape as the rest of the product:

| Status | Meaning |
| --- | --- |
| `401` | Missing or invalid token. `WWW-Authenticate: Basic` triggers a native credential prompt. |
| `403` | Token is missing `read` or `link`, or `Depth: infinity` was requested. |
| `404` | Search mode, unknown transfer, or unknown path. |
| `405` | Wrong method, or `GET`/`HEAD` on a folder. |
| `503` | The transfer exists but is unavailable in the download backend right now. |
