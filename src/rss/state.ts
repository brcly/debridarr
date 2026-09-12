// Poll status (last poll/error, recent items) is runtime state, not settings:
// it changes on every poll tick and a restart losing it is harmless — a
// re-add of an already-owned identity is a no-op at the download layer (see
// TransferService.add), so re-seeing an item after a restart costs a wasted
// network call at worst, never a duplicate download. In-memory only, same
// tradeoff as src/playback/active.ts and the backend snapshot cache.
export interface SavedSearchItem {
  guid: string;
  title: string;
  seenAt: number;
  status: 'added' | 'ignored' | 'error';
  error?: string;
}
export interface SavedSearchState {
  lastPolledAt?: number;
  lastError?: string;
  items: SavedSearchItem[];
}

const ITEM_HISTORY_LIMIT = 30;
const state = new Map<string, SavedSearchState>();

function ensure(searchId: string): SavedSearchState {
  let entry = state.get(searchId);
  if (!entry) { entry = { items: [] }; state.set(searchId, entry); }
  return entry;
}

export function savedSearchStatus(searchId: string): SavedSearchState | undefined {
  return state.get(searchId);
}

export function allSavedSearchStatus(): Record<string, SavedSearchState> {
  return Object.fromEntries(state);
}

export function isItemSeen(searchId: string, guid: string): boolean {
  return state.get(searchId)?.items.some(item => item.guid === guid) ?? false;
}

// Used both for automatic processing (added/error) and a manual "ignore" from
// the dashboard: either way, the guid becomes seen so a later poll of the
// same feed does not reprocess it. Re-recording an already-seen guid (e.g.
// ignoring an item that previously errored) replaces its entry in place.
export function recordItem(searchId: string, item: { guid: string; title: string; status: SavedSearchItem['status']; error?: string }): void {
  const entry = ensure(searchId);
  entry.items = entry.items.filter(existing => existing.guid !== item.guid);
  entry.items.unshift({ ...item, seenAt: Date.now() });
  entry.items.length = Math.min(entry.items.length, ITEM_HISTORY_LIMIT);
}

export function recordPoll(searchId: string, error?: string): void {
  const entry = ensure(searchId);
  entry.lastPolledAt = Date.now();
  if (error === undefined) delete entry.lastError;
  else entry.lastError = error;
}

// Drops state for a search no longer in settings, so deleting and re-adding
// a search (or simply forgetting about a removed one) does not leak memory.
export function pruneSearches(activeIds: readonly string[]): void {
  const keep = new Set(activeIds);
  for (const id of state.keys()) if (!keep.has(id)) state.delete(id);
}
