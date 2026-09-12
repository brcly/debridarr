import type { ReleaseSource } from './source.js';
import type { DiscoveryProviderSettings, DiscoveryProviderType } from './config.js';
import type { Settings } from '../settings.js';
import type { DiscoverySource } from '../search/index.js';
import { ProwlarrClient } from '../integrations/prowlarr/client.js';
import { TorznabClient } from '../integrations/torznab/client.js';

export interface DiscoveryFieldDescriptor {
  key: 'url' | 'apiKey';
  label: string;
  input: 'url' | 'text' | 'password';
  secret?: boolean;
  required?: boolean;
  placeholder: string;
}

export interface DiscoveryProviderDescriptor {
  type: DiscoveryProviderType;
  label: string;
  description: string;
  fields: DiscoveryFieldDescriptor[];
}

interface DiscoveryProviderRegistration {
  descriptor: DiscoveryProviderDescriptor;
  create(settings: DiscoveryProviderSettings): ReleaseSource;
}

const registrations: Record<DiscoveryProviderType, DiscoveryProviderRegistration> = {
  prowlarr: {
    descriptor: {
      type: 'prowlarr',
      label: 'Prowlarr',
      description: 'Search torrent and Usenet indexers through Prowlarr.',
      fields: [
        { key: 'url', label: 'Address', input: 'url', required: true, placeholder: 'http://prowlarr:9696' },
        { key: 'apiKey', label: 'API key', input: 'password', secret: true, required: true, placeholder: 'Prowlarr API key' },
      ],
    },
    create: settings => new ProwlarrClient(settings),
  },
  torznab: {
    descriptor: {
      type: 'torznab',
      label: 'Torznab',
      description: 'Search a single Torznab-compatible indexer directly, without an aggregator.',
      fields: [
        { key: 'url', label: 'Address', input: 'url', required: true, placeholder: 'http://indexer:9117/torznab/api' },
        { key: 'apiKey', label: 'API key', input: 'password', secret: true, placeholder: 'API key (if the indexer requires one)' },
      ],
    },
    create: settings => new TorznabClient(settings),
  },
};

export function discoveryProviderDescriptors(): DiscoveryProviderDescriptor[] {
  return Object.values(registrations).map(({ descriptor }) => structuredClone(descriptor));
}

export function discoveryProviderDescriptor(type: DiscoveryProviderType): DiscoveryProviderDescriptor {
  return structuredClone(registrations[type].descriptor);
}

export function createRegisteredDiscoveryProvider(settings: DiscoveryProviderSettings): ReleaseSource {
  return registrations[settings.type].create(settings);
}

// The sources search runs across for a settings snapshot: every configured
// discovery provider, each paired with its own content preferences.
export function configuredDiscoverySources(settings: Pick<Settings, 'discovery'>): DiscoverySource[] {
  return settings.discovery.providers.map(provider => ({
    source: createRegisteredDiscoveryProvider(provider),
    preferences: provider.preferences,
  }));
}

// Origins the download proxy may fetch from, beyond a matching provider's own
// origin: a release's own download link lives on the provider that returned
// it. `type` lets the proxy apply Prowlarr's stricter shape check.
export function discoveryProxyTargets(settings: Pick<Settings, 'discovery'>): { url: string; apiKey: string; type: DiscoveryProviderType }[] {
  return settings.discovery.providers.filter(provider => provider.url)
    .map(provider => ({ url: provider.url, apiKey: provider.apiKey, type: provider.type }));
}
