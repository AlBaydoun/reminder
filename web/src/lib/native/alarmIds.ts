import type { DueReminder } from '../types';

/**
 * Notification ids, allocated rather than hashed.
 *
 * Local notifications are addressed by a signed 32-bit integer, while
 * reminders have string ids and a repeating one has many occurrences. The
 * obvious answer is to hash the two together — and it is wrong. Android caps
 * the id at about 2.1 billion, and the birthday bound says a few tens of
 * thousands of ids in that space collide roughly a quarter of the time. A
 * collision here is not a glitch: two alarms share an id, one silently
 * replaces the other, and an alarm never rings. That is the one failure this
 * app cannot have.
 *
 * So ids are handed out from a counter and remembered. Allocation cannot
 * collide, the stored map makes an id findable again to cancel it, and
 * pruning past occurrences keeps the map from growing without bound.
 *
 * If the map is ever lost — a reinstall, cleared storage — ids restart and
 * could in principle clash with notifications the OS still holds from before.
 * That heals itself: the scheduler cancels every pending notification it did
 * not just ask for, and after a reset it asks for entirely new ids.
 */

/** How long a closed-app alarm keeps trying, in seconds after the first ring. */
export const ESCALATION_STEPS = [30, 60, 120, 180, 300];

const STORAGE_KEY = 'nexus.alarmIds';
/** Android's notification id is a Java int; stay well inside it. */
const MAX_ID = 2_000_000_000;
/** Occurrences older than this are gone; their ids can be forgotten. */
const PRUNE_AFTER_MS = 60 * 60_000;

export type AlarmSlot = 'main' | `lead${number}` | `esc${number}`;

interface Registry {
  next: number;
  /** `${reminderId}|${occurrence}|${slot}` → id */
  ids: Record<string, number>;
}

/**
 * Storage is injectable so this is testable without a browser — and because
 * the fallback matters: in private mode the map lives for one run, which
 * still gives correct ids for as long as the app is open.
 */
export interface IdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): IdStorage {
  try {
    if (typeof localStorage !== 'undefined') {
      // Prove it works before trusting it; Safari's private mode throws on write.
      localStorage.getItem(STORAGE_KEY);
      return localStorage;
    }
  } catch {
    /* fall through to memory */
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
  };
}

let storage: IdStorage = defaultStorage();
let registry: Registry | null = null;

/** Point the registry at different storage. Used by the tests. */
export function useIdStorage(next: IdStorage) {
  flushIds();
  storage = next;
  registry = null;
  dirty = false;
}

function load(): Registry {
  if (registry) return registry;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Registry) : null;
    registry =
      parsed && typeof parsed.next === 'number' && parsed.ids
        ? { next: parsed.next, ids: parsed.ids }
        : { next: 1, ids: {} };
  } catch {
    registry = { next: 1, ids: {} };
  }
  return registry;
}

/**
 * Writes are batched.
 *
 * Serialising the whole map on every allocation is quadratic — scheduling a
 * few hundred alarms would rewrite a growing blob a few hundred times — and
 * it buys nothing, because a sync allocates its ids in one burst. The flush
 * happens once the burst is over, and `flushIds` forces it where the timing
 * matters.
 */
let dirty = false;
let flushQueued = false;

function markDirty() {
  dirty = true;
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    flushIds();
  });
}

/** Write the map out now. Safe to call when nothing has changed. */
export function flushIds(): void {
  if (!dirty || !registry) return;
  dirty = false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(registry));
  } catch {
    /* the map still holds for this run */
  }
}

const keyFor = (reminderId: string, occurrence: string, slot: AlarmSlot) =>
  `${reminderId}|${occurrence}|${slot}`;

/**
 * The id for one notification, allocating it the first time and returning the
 * same one ever after — which is what makes an alarm cancellable.
 */
export function idFor(reminderId: string, occurrence: string, slot: AlarmSlot): number {
  const current = load();
  const key = keyFor(reminderId, occurrence, slot);
  const existing = current.ids[key];
  if (existing !== undefined) return existing;

  const id = current.next;
  // Wrapping needs two billion alarms to reach, and pruning means the early
  // ids are long forgotten by then — but wrapping to 1 rather than past the
  // int range is still the only safe thing to do.
  current.next = current.next >= MAX_ID ? 1 : current.next + 1;
  current.ids[key] = id;
  markDirty();
  return id;
}

/** The id if one was already handed out, without allocating a new one. */
export function existingId(
  reminderId: string,
  occurrence: string,
  slot: AlarmSlot,
): number | undefined {
  return load().ids[keyFor(reminderId, occurrence, slot)];
}

export const mainId = (reminderId: string, occurrence: string) =>
  idFor(reminderId, occurrence, 'main');
export const leadId = (reminderId: string, occurrence: string, minutes: number) =>
  idFor(reminderId, occurrence, `lead${minutes}`);
export const escalationId = (reminderId: string, occurrence: string, seconds: number) =>
  idFor(reminderId, occurrence, `esc${seconds}`);

/**
 * Every notification id one occurrence of a reminder owns.
 *
 * This is what acknowledging an alarm has to cancel. Missing any of them
 * leaves a snoozed alarm going off again moments later.
 */
export function idsForOccurrence(reminder: DueReminder, occurrence: string): number[] {
  return [
    mainId(reminder.id, occurrence),
    ...reminder.leadMinutes.map((lead) => leadId(reminder.id, occurrence, lead)),
    ...ESCALATION_STEPS.map((step) => escalationId(reminder.id, occurrence, step)),
  ];
}

/**
 * Forget the ids of occurrences that have already passed.
 *
 * Without this the map grows for the life of the install. Run after each sync,
 * when the alarms still in play are known.
 */
export function pruneIds(now = Date.now()): number {
  const current = load();
  let removed = 0;
  for (const key of Object.keys(current.ids)) {
    const occurrence = key.split('|')[1];
    const at = Date.parse(occurrence);
    // An unparseable key is not something to guess about; leave it alone.
    if (Number.isFinite(at) && at < now - PRUNE_AFTER_MS) {
      delete current.ids[key];
      removed++;
    }
  }
  if (removed) {
    markDirty();
    flushIds();
  }
  return removed;
}

/** How many ids are being remembered. Exposed so the size can be asserted on. */
export const trackedIdCount = () => Object.keys(load().ids).length;
