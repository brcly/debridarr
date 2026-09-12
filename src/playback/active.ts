// Tracks infohashes currently being streamed by /play so the retention
// sweeper never deletes a title mid-stream. Refcounted because Stremio (or a
// seek) can open more than one concurrent range request against the same file.
const active = new Map<string, number>();

export function markActive(infoHash: string): void {
  const key = infoHash.toLowerCase();
  active.set(key, (active.get(key) ?? 0) + 1);
}

export function markInactive(infoHash: string): void {
  const key = infoHash.toLowerCase();
  const count = (active.get(key) ?? 1) - 1;
  if (count <= 0) active.delete(key);
  else active.set(key, count);
}

export function isActive(infoHash: string): boolean {
  return active.has(infoHash.toLowerCase());
}

export function activeCount(): number {
  return active.size;
}
