import { BusyError } from '../security/admission.js';
const instances = new WeakMap<object, Map<string, { tail: Promise<unknown>; count: number }>>();
export class ConflictError extends Error {
  readonly status = 409;
  constructor(message = 'Torrent ownership could not be verified. No torrent changes were made.') { super(message); }
}
// One coordinator per durable store, shared by administration, playback and sweeping.
export async function coordinated<T>(store: object, hash: string, work: () => Promise<T>): Promise<T> {
  let locks = instances.get(store);
  if (!locks) { locks = new Map(); instances.set(store, locks); }
  const key = hash.toLowerCase();
  let lock = locks.get(key);
  if (!lock) { lock = { tail: Promise.resolve(), count: 0 }; locks.set(key, lock); }
  if (lock.count >= 32) throw new BusyError();
  lock.count++;
  const operation = lock.tail.then(work);
  lock.tail = operation.catch(() => {});
  try { return await operation; }
  finally { if (--lock.count === 0) locks.delete(key); }
}
