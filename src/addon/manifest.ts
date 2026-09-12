import type { OperatingMode } from '../settings.js';

export const LIBRARY_CATALOG_ID = 'debridarr-library';

// The manifest depends on the operating mode: `store`/`both` also advertise the
// `db:` id prefix, a My Library catalog, and its `meta` so hand-added torrents
// with no IMDb id are browsable and playable in Stremio.
export function buildManifest(mode: OperatingMode) {
  const store = mode !== 'search';
  return {
    id: 'org.debridarr.addon',
    version: '0.2.0',
    name: 'Debridarr',
    description: 'Self-hosted streams powered by Prowlarr and your download client. Searches your indexers, downloads your pick, and streams it back — no separate debrid provider needed.',
    resources: [
      { name: 'stream', types: store ? ['movie', 'series', 'other'] : ['movie', 'series'], idPrefixes: store ? ['tt', 'db'] : ['tt'] },
      ...(store ? [{ name: 'meta', types: ['other'], idPrefixes: ['db'] }] : []),
    ],
    types: store ? ['movie', 'series', 'other'] : ['movie', 'series'],
    catalogs: store ? [{
      type: 'other', id: LIBRARY_CATALOG_ID, name: 'Debridarr Library',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    }] : [],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
