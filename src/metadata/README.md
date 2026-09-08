# Metadata resolution

Turns a Stremio stream id into a `ResolvedTitle` (title, year, and — for series —
the season/episode from the id) that the search layer uses to build Prowlarr
queries. This module never advertises a Stremio metadata resource.

`ResolvedTitle.alternateTitles` carries any original-language title a provider
exposes distinct from the localized one (currently only TMDB's
`original_title`/`original_name`; Cinemeta's is always `[]`) — useful for
foreign-language films, anime, and internationally retitled releases whose
scene names use the original title. The search layer queries and matches
against it too.

- `id.ts` — `parseMediaId(type, id)` validates `tt…` movie ids and
  `tt…:season:episode` series ids (season 0 allowed) and is the single source of
  truth for what the addon accepts.
- `cinemeta.ts` — Stremio's own IMDb-keyed catalogue (`v3-cinemeta.strem.io`).
  No credentials.
- `tmdb.ts` — TMDB's `/find` endpoint, keyed by IMDb id, using a v3 API key
  passed as a query parameter. Requires the key from settings.
- `index.ts` — `createMetadataProvider(settings.metadata)` picks the provider the
  administrator selected.

`http.ts` does a bounded, redirect-refusing JSON fetch and maps transport and
status failures to `MetadataError` codes (`not_configured`, `not_found`,
`unavailable`). Providers never surface upstream response bodies.
