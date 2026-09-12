import type { DownloadBackend, DownloadProtocol } from './download.js';
import type { DelugeBackendSettings, QBittorrentBackendSettings, SabnzbdBackendSettings, TorrentBackendSettings, TorrentBackendType, TransmissionBackendSettings } from './config.js';
import { DelugeClient } from '../integrations/deluge/client.js';
import { QBittorrentClient } from '../integrations/qbittorrent/client.js';
import { SabnzbdClient } from '../integrations/sabnzbd/client.js';
import { TransmissionClient } from '../integrations/transmission/client.js';

export interface BackendFieldDescriptor {
  key: 'url' | 'username' | 'password';
  label: string;
  input: 'url' | 'text' | 'password';
  secret?: boolean;
  required?: boolean;
  placeholder: string;
}

export interface BackendDescriptor {
  type: TorrentBackendType;
  label: string;
  description: string;
  protocol: DownloadProtocol;
  fields: BackendFieldDescriptor[];
}

interface BackendRegistration {
  descriptor: BackendDescriptor;
  create(settings: TorrentBackendSettings): DownloadBackend;
}

const registrations: Record<TorrentBackendType, BackendRegistration> = {
  qbittorrent: {
    descriptor: {
      type: 'qbittorrent',
      label: 'qBittorrent',
      description: 'Download and seed torrents through qBittorrent Web UI.',
      protocol: 'torrent',
      fields: [
        { key: 'url', label: 'Web UI address', input: 'url', required: true, placeholder: 'http://qbittorrent:8080' },
        { key: 'username', label: 'Username', input: 'text', required: true, placeholder: 'admin' },
        { key: 'password', label: 'Password', input: 'password', secret: true, required: true, placeholder: 'Web UI password' },
      ],
    },
    create: settings => new QBittorrentClient(settings as QBittorrentBackendSettings),
  },
  transmission: {
    descriptor: {
      type: 'transmission',
      label: 'Transmission',
      description: 'Download and seed torrents through the Transmission RPC API.',
      protocol: 'torrent',
      fields: [
        { key: 'url', label: 'RPC address', input: 'url', required: true, placeholder: 'http://transmission:9091/transmission/rpc' },
        { key: 'username', label: 'Username', input: 'text', placeholder: 'Leave blank if authentication is disabled' },
        { key: 'password', label: 'Password', input: 'password', secret: true, placeholder: 'Leave blank if authentication is disabled' },
      ],
    },
    create: settings => new TransmissionClient(settings as TransmissionBackendSettings),
  },
  deluge: {
    descriptor: {
      type: 'deluge',
      label: 'Deluge',
      description: 'Download and seed torrents through the Deluge Web JSON-RPC API.',
      protocol: 'torrent',
      fields: [
        { key: 'url', label: 'Web UI address', input: 'url', required: true, placeholder: 'http://deluge:8112' },
        { key: 'password', label: 'Password', input: 'password', secret: true, required: true, placeholder: 'Web UI password' },
      ],
    },
    create: settings => new DelugeClient(settings as DelugeBackendSettings),
  },
  sabnzbd: {
    descriptor: {
      type: 'sabnzbd',
      label: 'SABnzbd',
      description: 'Download NZBs through the SABnzbd API. Does not accept torrents.',
      protocol: 'usenet',
      fields: [
        { key: 'url', label: 'Web UI address', input: 'url', required: true, placeholder: 'http://sabnzbd:8080' },
        { key: 'password', label: 'API key', input: 'password', secret: true, required: true, placeholder: 'SABnzbd API key' },
      ],
    },
    create: settings => new SabnzbdClient(settings as SabnzbdBackendSettings),
  },
};

export function backendDescriptors(): BackendDescriptor[] {
  return Object.values(registrations).map(({ descriptor }) => structuredClone(descriptor));
}

export function backendDescriptor(type: TorrentBackendType): BackendDescriptor {
  return structuredClone(registrations[type].descriptor);
}

export function createRegisteredBackend(settings: TorrentBackendSettings): DownloadBackend {
  return registrations[settings.type].create(settings);
}
