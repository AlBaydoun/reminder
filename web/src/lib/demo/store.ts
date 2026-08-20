import type { CustomSound, Drawing, Item, Reminder, User } from '../types';

/**
 * Persistence for the demo build.
 *
 * The published demo has no server — it is a static page — so everything lives
 * in the visitor's own browser. IndexedDB rather than localStorage because
 * uploaded alarm sounds are Blobs, and base64-ing them into a 5 MB string
 * store would break as soon as someone uploaded a real song.
 */

const DB_NAME = 'nexus-demo';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const BLOB_STORE = 'blobs';
const STATE_KEY = 'workspace';

export interface DemoActivity {
  id: string;
  kind: string;
  itemId: string | null;
  createdAt: string;
}

export interface DemoBackup {
  id: string;
  kind: 'nightly' | 'manual' | 'pre-restore';
  filename: string;
  size: number;
  itemCount: number;
  createdAt: string;
  /** The snapshot itself, kept inline since there is no filesystem here. */
  payload: string;
}

export interface DemoState {
  user: User;
  items: Item[];
  reminders: Reminder[];
  drawings: Drawing[];
  sounds: CustomSound[];
  activity: DemoActivity[];
  backups: DemoBackup[];
  /** Inverse operations for the last voice batches, keyed by undo id. */
  undo: Record<string, unknown[]>;
  lastNightlyAt: string | null;
}

export const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const nowIso = () => new Date().toISOString();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = work(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export const readState = () =>
  withStore<DemoState | undefined>(STATE_STORE, 'readonly', (s) => s.get(STATE_KEY));

export const writeState = (state: DemoState) =>
  withStore<IDBValidKey>(STATE_STORE, 'readwrite', (s) => s.put(state, STATE_KEY));

export const readBlob = (id: string) => withStore<Blob | undefined>(BLOB_STORE, 'readonly', (s) => s.get(id));
export const writeBlob = (id: string, blob: Blob) =>
  withStore<IDBValidKey>(BLOB_STORE, 'readwrite', (s) => s.put(blob, id));
export const deleteBlob = (id: string) => withStore<undefined>(BLOB_STORE, 'readwrite', (s) => s.delete(id));

export async function clearAll(): Promise<void> {
  await withStore(STATE_STORE, 'readwrite', (s) => s.clear());
  await withStore(BLOB_STORE, 'readwrite', (s) => s.clear());
}

/** Blob URLs for uploaded sounds, so the player can reach them without a server. */
const soundUrls = new Map<string, string>();

export function registerSoundUrl(id: string, blob: Blob): string {
  const existing = soundUrls.get(id);
  if (existing) URL.revokeObjectURL(existing);
  const url = URL.createObjectURL(blob);
  soundUrls.set(id, url);
  return url;
}

export function soundUrl(id: string): string | undefined {
  return soundUrls.get(id);
}

export function forgetSoundUrl(id: string) {
  const url = soundUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  soundUrls.delete(id);
}

/** Re-create object URLs for every stored sound after a page reload. */
export async function rehydrateSoundUrls(sounds: CustomSound[]): Promise<CustomSound[]> {
  const out: CustomSound[] = [];
  for (const sound of sounds) {
    const blob = await readBlob(sound.id);
    out.push(blob ? { ...sound, url: registerSoundUrl(sound.id, blob) } : sound);
  }
  return out;
}

const item = (partial: Partial<Item> & { id: string; title: string }): Item => ({
  parentId: null,
  notes: '',
  icon: '',
  color: '',
  status: 'open',
  priority: 2,
  energy: 3,
  effortMinutes: 0,
  dueAt: null,
  startAt: null,
  recurrence: null,
  tags: [],
  blockedBy: [],
  meta: {},
  position: 0,
  pinned: false,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  completedAt: null,
  deletedAt: null,
  ...partial,
});

/**
 * The demo opens on a workspace that already shows the central idea: "Cars"
 * has children so it reads as a category, "Clean the kitchen" has none so it
 * reads as a task, and both are the same kind of row. Dates are relative to
 * the visit so the Today, Timeline and Focus views are never empty.
 */
export function seedState(): DemoState {
  const now = new Date();
  const at = (days: number, hour: number, minute = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  };

  const cars = newId();
  const cruiser = newId();
  const corolla = newId();
  const home = newId();
  const work = newId();

  const items: Item[] = [
    item({ id: cars, title: 'Cars', icon: '🚗', color: '#4cc2ff', position: 0,
      notes: 'One child per vehicle. Each vehicle keeps its own maintenance list.' }),
    item({ id: cruiser, title: 'Land Cruiser', icon: '🛻', color: '#4cc2ff', parentId: cars, position: 0 }),
    item({ id: newId(), title: 'Oil change', icon: '🛢️', parentId: cruiser, position: 0,
      dueAt: at(-1, 9), priority: 3, effortMinutes: 45,
      recurrence: { freq: 'monthly', interval: 3 } }),
    item({ id: newId(), title: 'Renew insurance', icon: '📄', parentId: cruiser, position: 1,
      dueAt: at(5, 10), priority: 4, effortMinutes: 30 }),
    item({ id: corolla, title: 'Corolla', icon: '🚙', color: '#4cc2ff', parentId: cars, position: 1 }),
    item({ id: newId(), title: 'Replace front tyres', icon: '🛞', parentId: corolla, position: 0,
      dueAt: at(2, 11), effortMinutes: 90, energy: 4 }),
    item({ id: newId(), title: 'Wash it', icon: '🧼', parentId: corolla, position: 1,
      effortMinutes: 20, status: 'done', completedAt: at(-1, 16) }),

    item({ id: home, title: 'Home', icon: '🏠', color: '#8b7bff', position: 1 }),
    item({ id: newId(), title: 'Fix the balcony light', icon: '💡', parentId: home, position: 0,
      dueAt: at(0, 18), effortMinutes: 25 }),
    item({ id: newId(), title: 'Water the plants', icon: '🪴', parentId: home, position: 1,
      dueAt: at(0, 8), effortMinutes: 10,
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 4], at: [{ hour: 8, minute: 0 }] } }),
    item({ id: newId(), title: 'Order a new filter', icon: '📦', parentId: home, position: 2, effortMinutes: 10 }),

    item({ id: work, title: 'Work', icon: '💼', color: '#3ddc97', position: 2 }),
    item({ id: newId(), title: 'Send the quarterly report', icon: '📈', parentId: work, position: 0,
      dueAt: at(1, 14), priority: 4, effortMinutes: 120, energy: 5 }),
    item({ id: newId(), title: 'Book the meeting room', icon: '🗓️', parentId: work, position: 1,
      dueAt: at(1, 9), effortMinutes: 5 }),

    // No children — so these rows *are* the to-do items.
    item({ id: newId(), title: 'Clean the kitchen', icon: '🧽', color: '#3ddc97', position: 3, effortMinutes: 30 }),
    item({ id: newId(), title: 'Call the dentist', icon: '🦷', color: '#ff8a5c', position: 4,
      dueAt: at(3, 9), effortMinutes: 10 }),
  ];

  const reminders: Reminder[] = [
    {
      id: newId(),
      itemId: items.find((i) => i.title === 'Water the plants')!.id,
      label: '',
      fireAt: at(0, 8),
      nextFireAt: at(1, 8),
      rrule: { freq: 'weekly', interval: 1, byWeekday: [1, 4], at: [{ hour: 8, minute: 0 }] },
      soundId: 'builtin:birdsong',
      volume: 0.9,
      vibrate: true,
      leadMinutes: [],
      snoozeMinutes: 9,
      snoozedUntil: null,
      escalate: false,
      ringSeconds: 60,
      status: 'scheduled',
      lastFiredAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: newId(),
      itemId: items.find((i) => i.title === 'Send the quarterly report')!.id,
      label: 'Quarterly report is due',
      fireAt: at(1, 13),
      nextFireAt: at(1, 13),
      rrule: null,
      soundId: 'builtin:radar',
      volume: 1,
      vibrate: true,
      leadMinutes: [30],
      snoozedUntil: null,
      snoozeMinutes: 10,
      escalate: true,
      ringSeconds: 90,
      status: 'scheduled',
      lastFiredAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ];

  // A short completion history so the streak and insight panels have shape.
  const activity: DemoActivity[] = [];
  for (let day = 1; day <= 6; day++) {
    const count = day % 4 === 0 ? 0 : 1 + (day % 3);
    for (let n = 0; n < count; n++) {
      activity.push({
        id: newId(),
        kind: 'item.completed',
        itemId: null,
        createdAt: at(-day, 10 + n),
      });
    }
  }

  return {
    user: {
      id: 'demo-user',
      email: 'you@this-browser',
      name: 'there',
      locale: 'en',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      settings: { dailyCapacityMinutes: 240, workStartHour: 9, workEndHour: 19 },
      createdAt: nowIso(),
    },
    items,
    reminders,
    drawings: [],
    sounds: [],
    activity,
    backups: [],
    undo: {},
    lastNightlyAt: null,
  };
}
