import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoveryProviderPreferences } from '../src/discovery/config.js';
import { configuredDiscoverySources, createRegisteredDiscoveryProvider, discoveryProviderDescriptor, discoveryProviderDescriptors, discoveryProxyTargets } from '../src/discovery/registry.js';

const noPreferences = (): DiscoveryProviderPreferences => ({ languages: [], resolutions: [], codecs: [] });

test('discovery registry exposes prowlarr and torznab', () => {
  const descriptors = discoveryProviderDescriptors();
  assert.deepEqual(descriptors.map(d => d.type), ['prowlarr', 'torznab']);
  assert.deepEqual(descriptors[0], discoveryProviderDescriptor('prowlarr'));
  assert.deepEqual(descriptors[1], discoveryProviderDescriptor('torznab'));
  descriptors[0].fields.push({ key: 'url', label: 'tampered', input: 'text', placeholder: '' });
  assert.equal(discoveryProviderDescriptor('prowlarr').fields.length, 2);
});

test('createRegisteredDiscoveryProvider builds a working ReleaseSource for its type', () => {
  const source = createRegisteredDiscoveryProvider({ id: 'p1', type: 'prowlarr', url: 'http://prowlarr.test', apiKey: 'key', preferences: noPreferences() });
  assert.equal(source.configured, true);
  const unconfigured = createRegisteredDiscoveryProvider({ id: 'p2', type: 'prowlarr', url: '', apiKey: '', preferences: noPreferences() });
  assert.equal(unconfigured.configured, false);
  const torznab = createRegisteredDiscoveryProvider({ id: 't1', type: 'torznab', url: 'http://indexer.test', apiKey: '', preferences: noPreferences() });
  assert.equal(torznab.configured, true);
  const unconfiguredTorznab = createRegisteredDiscoveryProvider({ id: 't2', type: 'torznab', url: '', apiKey: '', preferences: noPreferences() });
  assert.equal(unconfiguredTorznab.configured, false);
});

test('configured sources pair each provider with its own preferences; proxy targets list only configured origins', () => {
  const filters: DiscoveryProviderPreferences = { languages: ['fr'], resolutions: [1080], codecs: [] };
  const provider = { id: 'direct', type: 'torznab' as const, url: 'http://indexer.test', apiKey: 'key', preferences: filters };
  const blank = { id: 'agg', type: 'prowlarr' as const, url: '', apiKey: '', preferences: noPreferences() };
  const settings = { discovery: { providers: [provider, blank] } };
  const sources = configuredDiscoverySources(settings);
  assert.equal(sources.length, 2);
  assert.equal(sources[0]!.source.configured, true);
  assert.deepEqual(sources[0]!.preferences, filters, 'each source carries its own provider preferences');
  assert.equal(sources[1]!.source.configured, false, 'a provider without a URL stays unconfigured');
  assert.deepEqual(discoveryProxyTargets(settings), [{ url: 'http://indexer.test', apiKey: 'key', type: 'torznab' }], 'only providers with an address are proxy targets');
  assert.deepEqual(configuredDiscoverySources({ discovery: { providers: [] } }), [], 'no providers means no sources');
});
