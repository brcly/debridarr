# Downloads

`manager.ts` validates the server-side release source and coordinates torrent
registration separately from each request's file selection. It persists intent
before adding a stopped torrent with a unique ownership tag. The resulting
client/category/tag must match before any further torrent mutations. Unrelated
existing torrents are refused with 409.

- `coordinator.ts` serializes operations per store/hash; preparation admission
  allows two operations, with serialized cross-hash admission for the ten
  incomplete-download cap.
- `ownership.ts` verifies ownership and migrates legacy records only with
  matching category, hash and recorded file index/name/size.
- `deletion.ts` persists pending deletion, checks ownership and active playback,
  then retains the record until a direct hash lookup confirms absence. Failed
  deletions remain retryable and block new playback/Keep.
- `pick.ts` selects the largest suitable movie file or matching episode.
  Samples and extras are excluded. Selected file indices accumulate so a second
  episode request does not disable the first.
- `magnet.ts` extracts v1 infohashes, including base32 magnets.
- `torrentFile.ts` hashes the original bencoded info dictionary. Network source
  validation, redirect restrictions, DNS pinning and bounded fetching live in
  `src/security/torrentSource.ts`. The original .torrent bytes are uploaded to
  preserve trackers, even when the search also supplied an infohash.
- `store.ts` maintains schema 2 downloads.json with lifecycle, ownership,
  selected files, Keep and lease state. Schema 1 records are preserved. Writes
  are serialized, atomic and fsynced; corrupt storage is not reset.

Preparation sets unlimited per-torrent share limits to prevent inherited removal.
The retention sweeper manages seeding and expiry, with startup/hourly recovery
for interrupted registrations and pending deletions. Playback reservations are
acquired under the coordinator and retained until the response finishes.
