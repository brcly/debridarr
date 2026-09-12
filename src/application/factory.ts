import type { Settings } from '../settings.js';
import type { DownloadsRepository } from '../state/repositories.js';
import type { DownloadBackend } from '../backends/download.js';
import type { TransferLinkIssuer } from './types.js';
import { TransferService } from './transfers.js';
import { createDownloadBackend } from '../backends/factory.js';
import { discoveryProxyTargets } from '../discovery/registry.js';
import type { DiscoveryProviderType } from '../discovery/config.js';
import { fetchTorrentSource } from '../security/torrentSource.js';
import { nativeLinkIssuer } from '../api/v1/links.js';

// One place where a TransferService is assembled from settings.
//
// Eight call sites used to spell out the same five retention/store fields by
// hand and already disagreed about which optional dependencies they passed, so
// any new field would have been missed in at least one of them. Callers now
// say only what actually differs: whether they issue links, and whether they
// resolve remote sources.

export function backendFor(settings: Settings): DownloadBackend {
  return createDownloadBackend(settings.downloadBackend);
}

export interface TransferServiceParts {
  settings: Settings;
  downloads: DownloadsRepository;
  // Pass an existing backend when the caller also needs it directly, so the
  // request works against one instance rather than two.
  backend?: DownloadBackend;
  // Link issuance is needed only by callers that hand out /api/v1/download
  // URLs. Supply either a ready issuer or the pair used to build the native one.
  links?: TransferLinkIssuer | { appUrl: string; linkSecret: Buffer };
  // Required only to add a `downloadUrl` source (NZB, or a torrent from a
  // discovery provider); it carries the provider allowlist for SSRF control.
  resolveSources?: boolean;
  // Origins trusted for their own links in addition to the configured
  // discovery providers. Used by the RSS poller for the feed's own origin.
  extraProxyTargets?: readonly { url: string; apiKey: string; type: DiscoveryProviderType }[];
}

export function transferServiceFor(parts: TransferServiceParts): TransferService {
  const { settings, downloads, backend = backendFor(settings), links, resolveSources, extraProxyTargets = [] } = parts;
  const proxyTargets = [...discoveryProxyTargets(settings), ...extraProxyTargets];
  return new TransferService({
    downloads,
    backend,
    leaseDays: settings.retention.storeLeaseDays,
    maxActiveDownloads: settings.store.maxActiveDownloads,
    minFreeSpaceGB: settings.retention.minFreeSpaceGB,
    ...(links
      ? { links: 'issue' in links ? links : nativeLinkIssuer(`${links.appUrl}/api/v1`, links.linkSecret) }
      : {}),
    ...(resolveSources
      ? { sourceResolver: (url: string, signal: AbortSignal) => fetchTorrentSource(url, signal, proxyTargets) }
      : {}),
  });
}
