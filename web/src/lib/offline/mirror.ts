import type { CustomSound, Drawing, Item, Reminder, User } from '../types';

/**
 * A local copy of everything the server knows.
 *
 * Kept so the app still works with no connection. It is a *mirror*, not a
 * second source of truth: the server wins on every field it reports, and the
 * only local edits that survive a refresh are the ones still waiting in the
 * outbox. Anything else would mean two divergent copies and a merge nobody
 * asked for.
 *
 * IndexedDB rather than localStorage because a workspace with a few thousand
 * items and a handful of sketches is well past a five-megabyte string store.
 */

const DB_NAME = 'nexus-mirror';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'workspace';

export interface MirrorState {
  user: User | null;
  items: Item[];
  reminders: Reminder[];
  drawings: Drawing[];
  sounds: CustomSound[];
  /** When the server last confirmed this picture. */
  syncedAt: string | null;
}

export const emptyMirror = (): MirrorState => ({
  user: null,
  items: [],
  reminders: [],
  drawings: [],
  sounds: [],
  syncedAt: null,
});

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The in-memory copy is what everything reads.
 *
 * A read has to be synchronous-ish and immediate — the whole point is that a
 * view renders instantly when the network is gone — so IndexedDB is the
 * durability layer behind an object held in memory, not the thing on the
 * critical path.
 */
let cache: MirrorState | null = null;
let writeQueued = false;
let available = true;

export async function loadMirror(): Promise<MirrorState> {
  if (cache) return cache;
  try {
    const db = await openDb();
    cache = await new Promise<MirrorState>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as MirrorState) ?? emptyMirror());
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Private mode, or storage denied. The app still runs; it just cannot
    // remember anything once it is closed.
    available = false;
    cache = emptyMirror();
  }
  return cache;
}

/** The mirror as it stands, without waiting. Empty until `loadMirror` has run. */
export const mirrorNow = (): MirrorState => cache ?? emptyMirror();

export const mirrorAvailable = () => available;

/**
 * Writes are coalesced.
 *
 * A sync updates items, reminders, drawings and sounds in quick succession;
 * serialising the whole workspace once per collection would write it four
 * times for one refresh.
 */
function persist() {
  if (!available || writeQueued) return;
  writeQueued = true;
  queueMicrotask(async () => {
    writeQueued = false;
    const state = cache;
    if (!state) return;
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(state, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      available = false;
    }
  });
}

export function updateMirror(patch: Partial<MirrorState>): MirrorState {
  cache = { ...(cache ?? emptyMirror()), ...patch };
  persist();
  return cache;
}

/** Record what the server just said. */
export function recordFromServer(patch: Partial<Omit<MirrorState, 'syncedAt'>>): MirrorState {
  return updateMirror({ ...patch, syncedAt: new Date().toISOString() });
}

/** Apply a local change so the interface reflects it before the server has heard. */
export function patchMirror(mutate: (state: MirrorState) => MirrorState): MirrorState {
  cache = mutate(cache ?? emptyMirror());
  persist();
  return cache;
}

/** Sign-out, or a demo reset: the mirror belongs to one account. */
export async function clearMirror(): Promise<void> {
  cache = emptyMirror();
  if (!available) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* nothing to clear */
  }
}
