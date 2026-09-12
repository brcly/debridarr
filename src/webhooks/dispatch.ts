import { createHmac } from 'node:crypto';
import type { DownloadRecord } from '../downloads/store.js';
import type { DownloadsRepository, SettingsRepository } from '../state/repositories.js';
import { log } from '../log.js';
import { WEBHOOK_TIMEOUT_MS } from '../timeouts.js';

export type WebhookEventName = 'managed' | 'failed' | 'deleted';
export interface WebhookEvent {
  event: WebhookEventName;
  id: string;
  name: string;
  lifecycle?: string;
  media?: DownloadRecord['media'];
}

function deliver(url: string, secret: string, payload: WebhookEvent): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Debridarr-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  void fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) })
    .then(response => { if (!response.ok) log.warn(`Debridarr webhook to ${url} responded with status ${response.status}`); })
    .catch((error: unknown) => log.warn(`Debridarr webhook to ${url} failed: ${error instanceof Error ? error.message : String(error)}`));
}

function toEvent(event: WebhookEventName, record: DownloadRecord): WebhookEvent {
  return {
    event, id: record.infoHash, name: record.name,
    ...(record.lifecycle ? { lifecycle: record.lifecycle } : {}),
    ...(record.media ? { media: record.media } : {}),
  };
}

// Wraps the shared downloads repository so a transfer becoming managed or
// failed, or a confirmed deletion, notifies the configured webhook — whether
// the write came from an API create, background recovery, or the retention
// sweep. No separate poller watches for lifecycle changes.
export function withWebhooks(downloads: DownloadsRepository, settings: SettingsRepository): DownloadsRepository {
  return {
    list: () => downloads.list(),
    get: infoHash => downloads.get(infoHash),
    setKept: (infoHash, kept) => downloads.setKept(infoHash, kept),
    renew: (infoHash, expiresAt) => downloads.renew(infoHash, expiresAt),
    async upsert(record) {
      const before = downloads.get(record.infoHash)?.lifecycle;
      const saved = await downloads.upsert(record);
      if (saved.lifecycle !== before && (saved.lifecycle === 'managed' || saved.lifecycle === 'failed')) {
        const { webhookUrl, webhookSecret } = settings.snapshot().connections;
        if (webhookUrl) deliver(webhookUrl, webhookSecret, toEvent(saved.lifecycle, saved));
      }
      return saved;
    },
    async remove(infoHash) {
      const record = downloads.get(infoHash);
      await downloads.remove(infoHash);
      if (record) {
        const { webhookUrl, webhookSecret } = settings.snapshot().connections;
        if (webhookUrl) deliver(webhookUrl, webhookSecret, toEvent('deleted', record));
      }
    },
  };
}
