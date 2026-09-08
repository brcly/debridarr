export const manifest = {
  id: 'org.debridarr.addon',
  version: '0.1.0',
  name: 'Debridarr',
  description: 'Self-hosted streams powered by Prowlarr and qBittorrent. Searches your indexers, downloads your pick, and streams it back — no separate debrid provider needed.',
  resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false },
};
