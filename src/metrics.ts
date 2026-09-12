// Process-local request counters, sampled by GET /api/admin/metrics. Reset
// on restart; this is a debugging aid, not a durable metric store.
const counts = { total: 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };

export function recordRequest(status: number): void {
  counts.total++;
  const bucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
  counts[bucket]++;
}

export function requestCounters(): Readonly<typeof counts> {
  return { ...counts };
}

export function resetRequestCounters(): void {
  counts.total = 0;
  counts['2xx'] = 0;
  counts['3xx'] = 0;
  counts['4xx'] = 0;
  counts['5xx'] = 0;
}
