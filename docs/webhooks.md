# Completion webhook

An optional HTTPS URL that Debridarr POSTs when a transfer becomes ready, fails
preparation, or is confirmed deleted. Configure it on **Connections → Webhook**.
The card is hidden in **Search** mode — there is no store front door to notify
about.

This is one operator webhook, not a bot farm. There is no Discord, Telegram, or
email channel.

## When it fires

Delivery is wrapped around the downloads store, so it does not matter whether
the write came from a dashboard add, `/api/v1`, recovery, RSS, or the retention
sweep. A new poller is not involved.

| `event` | When |
| --- | --- |
| `managed` | The transfer's lifecycle becomes `managed` (file list ready, ownership recorded). |
| `failed` | Preparation failed (`no_file`, `no_metadata`, and similar). |
| `deleted` | The record was actually removed after the backend confirmed deletion. |

Re-saving an already-managed transfer (Keep, a later file selection, a lease
renewal) is not a transition and does not fire. Entering `registering` or
`queued` does not fire either.

## Body

`Content-Type: application/json`. Times are not included; the `id` is the
stable 40-character transfer id.

```json
{
  "event": "managed",
  "id": "0123456789abcdef0123456789abcdef01234567",
  "name": "Title (2024)",
  "lifecycle": "managed",
  "media": { "imdbId": "tt1234567", "type": "movie" }
}
```

`lifecycle` is present when the record has one. `media` is present only when
the transfer was added with an IMDb id. A `deleted` payload still carries the
record as it was at removal (so `lifecycle` may be `deleting` if the sweep
started the delete).

## URL and signature

The URL must be **HTTPS**, with no userinfo, query, or fragment. Leave it blank
to disable.

An optional signing secret, when set, adds:

```
X-Debridarr-Signature: sha256=<hex>
```

That value is HMAC-SHA256 of the **raw request body** with the secret. Verify
it with a constant-time compare against a digest you compute yourself; do not
parse the JSON first.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function valid(body, header, secret) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

## Failure handling

The POST uses a 10-second timeout and is not awaited by the transfer path. A
down listener, a non-2xx status, or a timeout is logged at `warn` and **does
not** fail the add, the sweep, or playback. Debridarr does not retry a missed
delivery.

Treat the body as untrusted input from your own Debridarr instance. It can
carry a release title. Keep the URL on a network you control.
