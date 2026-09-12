# RSS saved searches

Poll an RSS or Torznab feed on an interval and add new matching items the same
way a manual "Cache a torrent" or `POST /api/v1/transfers` would. Configure
searches on **Connections → Saved searches**. The card is hidden in **Search**
mode — saved searches add to the store front door, and that front door is off.

There is no HTML scraper and no generic "download whatever URL is in the
feed" mode. Each item needs a magnet, a torrent/NZB `downloadUrl` from that
feed's origin, or (for Usenet) an NZB.

## What a search is

Up to 20 saved searches. Each has:

| Field | Meaning |
| --- | --- |
| Feed URL | HTTP(S), no userinfo. Query strings are kept — that is how a Torznab "copy RSS link" carries the search and its API key. |
| Protocol | `torrent` or `usenet`. Must match the download backend (a torrent client rejects NZB items; SABnzbd rejects magnets). |
| Title include / exclude | Optional case-insensitive substrings. Include requires a match; exclude drops a match before it is recorded. |
| `queue` | Same as `POST /api/v1/transfers` with `queue: true`: persist at the active-download cap instead of skipping the item. |
| `cachedOnly` | Same as `cachedOnly: true`: add only if this identity is already a playable managed transfer. |
| Enabled | A disabled search is not polled at all. |

A job walks every enabled search every **15 minutes**. The dashboard can poll
one search immediately. Last poll time, last error, and recent items (added,
ignored, or failed) are process-local — a restart forgets them. Re-seeing an
item after a restart costs a wasted add attempt at worst; an already-owned
identity is a no-op at the download layer, not a second torrent.

## How an item is added

1. The feed is fetched (20 s timeout, RSS/XML only).
2. Up to 50 items are parsed. Title filters run first.
3. A previously seen `guid` is skipped.
4. The item is passed to `TransferService.add` with the search's `queue` /
   `cachedOnly` flags. Admission caps, free-space checks, and ownership rules
   are the same as a dashboard or API add.

Ignore an item from the dashboard to mark its `guid` seen without adding it.

## Feed hosts and item links

Saving a search means Debridarr will fetch that URL on a timer. The
administrator is trusted to point it at an indexer they run or subscribe to
(see `SECURITY.md`). Credentials belong in the query string the indexer gave
you, not in the URL userinfo.

When a feed item uses a `downloadUrl` rather than a magnet, that URL must
share the **feed's origin**. Debridarr does not follow arbitrary third-party
file hosts from RSS. Magnets are validated the same way as a pasted magnet.

## Failures

A feed that is unreachable, not RSS, or times out is recorded as that search's
last error; other searches still run. An individual item that cannot be added
(no usable link, busy, low space, wrong protocol) is recorded on that item and
does not stop the rest of the feed. Those errors never fail playback or the
rest of the job runner.
