import type { api as ServerApi } from '../serverApi';
import {
  buildInsights,
  computeNextFire,
  dependencyReport,
  findDuplicates,
  scoreItems,
  streaks,
  suggestCategories,
  suggestSlots,
  workloadForecast,
} from '../demo/engine';
import type { DueReminder, Item, Overview, Reminder } from '../types';
import {
  loadMirror,
  mirrorNow,
  patchMirror,
  recordFromServer,
  clearMirror,
} from './mirror';
import {
  enqueue,
  hasUnresolvedIds,
  isTempId,
  newTempId,
  noteAttempt,
  pendingCount,
  pendingOps,
  realIdFor,
  removeOp,
  resolveTempId,
  substituteIds,
  type OutboxKind,
} from './outbox';

/**
 * The app, with the network treated as optional.
 *
 * This wraps the real API client rather than replacing it. Every call still
 * goes to the server first, because the server is the truth; what changes is
 * what happens when it cannot be reached. Reads fall back to a local mirror,
 * anything the server would have *reasoned* about is computed locally from the
 * same data, and writes go into a durable queue that is replayed in order once
 * there is a connection again.
 *
 * Some things honestly cannot be done offline and say so instead of pretending
 * — signing in, uploading a sound, taking a backup. Failing loudly there is
 * kinder than a queued operation that turns out to be impossible.
 */

export class OfflineError extends Error {
  readonly code = 'offline';
  constructor(message = 'This needs a connection') {
    super(message);
  }
}

/** Is this failure "the network is gone" rather than "the server said no"? */
function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch throws TypeError when it cannot reach
  const status = (error as { status?: number })?.status;
  // 0 is what a blocked or aborted request reports; 5xx means the server is
  // there but broken, which is not something a local queue can fix — except
  // 502/503/504, which are the shapes a proxy uses when the app is unreachable.
  if (status === undefined) return false;
  return status === 0 || status === 502 || status === 503 || status === 504;
}

type Listener = (state: OfflineState) => void;
export interface OfflineState {
  online: boolean;
  pending: number;
  syncing: boolean;
  lastSyncedAt: string | null;
  /** Operations dropped because the server rejected them outright. */
  rejected: number;
}

let online = typeof navigator === 'undefined' ? true : navigator.onLine;
let syncing = false;
let rejected = 0;
const listeners = new Set<Listener>();

export const offlineState = (): OfflineState => ({
  online,
  pending: pendingCount(),
  syncing,
  lastSyncedAt: mirrorNow().syncedAt,
  rejected,
});

function announce() {
  const snapshot = offlineState();
  for (const fn of listeners) fn(snapshot);
}

export function onOfflineChange(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setOnline(next: boolean) {
  if (online === next) return;
  online = next;
  announce();
}

// ── the mirror as a read source ───────────────────────────────────────────

const liveItems = (): Item[] => mirrorNow().items.filter((i) => !i.deletedAt);

function countsFor(items: Item[]): Record<string, { total: number; done: number }> {
  const counts: Record<string, { total: number; done: number }> = {};
  const byParent = new Map<string | null, Item[]>();
  for (const item of items) {
    const list = byParent.get(item.parentId) ?? [];
    list.push(item);
    byParent.set(item.parentId, list);
  }
  const walk = (id: string): { total: number; done: number } => {
    const children = byParent.get(id) ?? [];
    let total = 0;
    let done = 0;
    for (const child of children) {
      const below = walk(child.id);
      total += 1 + below.total;
      done += (child.status === 'done' ? 1 : 0) + below.done;
    }
    counts[id] = { total, done };
    return counts[id];
  };
  for (const item of items) if (!counts[item.id]) walk(item.id);
  return counts;
}

function localOverview(): Overview {
  const state = mirrorNow();
  const now = new Date();
  const capacity = Number(state.user?.settings?.dailyCapacityMinutes) || 240;
  const items = liveItems();
  const scored = scoreItems(items, now.getTime());
  return {
    focus: scored.slice(0, 25),
    // Insights that lean on activity history are thinner offline, because the
    // history lives on the server; the ones drawn from the tasks themselves
    // are exactly as good.
    insights: buildInsights(items, [], capacity, now),
    forecast: workloadForecast(items, capacity, 14, now),
    streak: streaks([], now),
    dependencies: dependencyReport(items),
    totals: {
      open: scored.length,
      blocked: scored.filter((s) => s.blocked).length,
      overdue: scored.filter((s) => s.item.dueAt && new Date(s.item.dueAt) < now).length,
    },
    timeZone: state.user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    serverTime: now.toISOString(),
  };
}

/** A reminder joined to its task, the way the server returns due ones. */
function withItem(reminder: Reminder): DueReminder | null {
  const item = mirrorNow().items.find((i) => i.id === reminder.itemId && !i.deletedAt);
  if (!item || item.status === 'done') return null;
  return {
    ...reminder,
    item: { id: item.id, title: item.title, icon: item.icon, color: item.color, status: item.status },
  };
}

// ── running a call ────────────────────────────────────────────────────────

/**
 * A read: server first, mirror second.
 *
 * `store` records what the server said, so the mirror is refreshed by ordinary
 * use rather than by a separate sync pass.
 */
async function read<T>(run: () => Promise<T>, store: (value: T) => void, fallback: () => T): Promise<T> {
  try {
    const value = await run();
    setOnline(true);
    store(value);
    return value;
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    setOnline(false);
    return fallback();
  }
}

/**
 * A write: server first, queue second.
 *
 * `optimistic` updates the mirror so the interface moves immediately, and is
 * also what the caller gets back — the same shape the server would have
 * returned, so nothing downstream needs to know which happened.
 */
async function write<T>(
  kind: OutboxKind,
  args: unknown[],
  run: () => Promise<T>,
  optimistic: () => T,
  creates?: string,
): Promise<T> {
  if (online) {
    try {
      const value = await run();
      setOnline(true);
      return value;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      setOnline(false);
    }
  }
  enqueue(kind, args, creates);
  const value = optimistic();
  announce();
  return value;
}

// ── replay ────────────────────────────────────────────────────────────────

let flushing: Promise<void> | null = null;

/**
 * Send everything that was done offline, oldest first.
 *
 * Order matters: a subtask created after its parent must not be sent before
 * it, so a single failure stops the run rather than skipping ahead. The one
 * exception is an operation the server *rejects* — a 4xx means replaying it
 * again will fail identically, so it is dropped and counted rather than
 * blocking every change behind it forever.
 */
export async function flushOutbox(server: typeof ServerApi): Promise<{ sent: number; failed: number }> {
  if (flushing) {
    await flushing;
    return { sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;

  flushing = (async () => {
    syncing = true;
    announce();
    try {
      for (const op of pendingOps()) {
        const args = substituteIds(op.args);
        if (hasUnresolvedIds(args)) {
          // Its parent has not been created yet; the op that creates it is
          // earlier in the queue and will have run first, so this means the
          // creation itself failed. Stop rather than send a broken reference.
          failed++;
          break;
        }
        try {
          noteAttempt(op.id);
          const result = await callServer(server, op.kind, args);
          if (op.creates) {
            const realId = (result as { id?: string })?.id;
            if (realId) {
              resolveTempId(op.creates, realId);
              adoptRealId(op.creates, realId);
            }
          }
          removeOp(op.id);
          sent++;
        } catch (error) {
          if (isNetworkFailure(error)) {
            setOnline(false);
            failed++;
            break;
          }
          // The server understood and refused. Replaying will not help.
          removeOp(op.id);
          rejected++;
          failed++;
        }
      }
    } finally {
      syncing = false;
      announce();
    }
  })();

  await flushing;
  flushing = null;
  return { sent, failed };
}

/** Point the mirror at the real id, so the interface stops showing a temporary one. */
function adoptRealId(tempId: string, realId: string) {
  patchMirror((state) => ({
    ...state,
    items: state.items.map((item) => ({
      ...item,
      id: item.id === tempId ? realId : item.id,
      parentId: item.parentId === tempId ? realId : item.parentId,
    })),
    reminders: state.reminders.map((reminder) => ({
      ...reminder,
      id: reminder.id === tempId ? realId : reminder.id,
      itemId: reminder.itemId === tempId ? realId : reminder.itemId,
    })),
    drawings: state.drawings.map((drawing) => ({
      ...drawing,
      id: drawing.id === tempId ? realId : drawing.id,
      itemId: drawing.itemId === tempId ? realId : drawing.itemId,
    })),
  }));
}

function callServer(server: typeof ServerApi, kind: OutboxKind, args: unknown[]): Promise<unknown> {
  switch (kind) {
    case 'createItem': return server.createItem(args[0] as Parameters<typeof ServerApi.createItem>[0]);
    case 'updateItem': return server.updateItem(args[0] as string, args[1] as Partial<Item>);
    case 'completeItem': return server.completeItem(args[0] as string, args[1] as boolean, args[2] as boolean);
    case 'moveItem': return server.moveItem(args[0] as string, args[1] as string | null, args[2] as number | undefined);
    case 'deleteItem': return server.deleteItem(args[0] as string, args[1] as boolean);
    case 'restoreItem': return server.restoreItem(args[0] as string);
    case 'reorderItems': return server.reorderItems(args[0] as string | null, args[1] as string[]);
    case 'createReminder': return server.createReminder(args[0] as Parameters<typeof ServerApi.createReminder>[0]);
    case 'updateReminder': return server.updateReminder(args[0] as string, args[1] as Partial<Reminder>);
    case 'deleteReminder': return server.deleteReminder(args[0] as string);
    case 'snoozeReminder': return server.snoozeReminder(args[0] as string, args[1] as number | undefined);
    case 'dismissReminder': return server.dismissReminder(args[0] as string);
    case 'createDrawing': return server.createDrawing(args[0] as Parameters<typeof ServerApi.createDrawing>[0]);
    case 'updateDrawing': return server.updateDrawing(args[0] as string, args[1] as Record<string, unknown>);
    case 'deleteDrawing': return server.deleteDrawing(args[0] as string);
  }
}

export {
  isNetworkFailure,
  liveItems,
  countsFor,
  localOverview,
  withItem,
  read,
  write,
  setOnline,
  announce,
  loadMirror,
  clearMirror,
  recordFromServer,
  patchMirror,
  newTempId,
  isTempId,
  realIdFor,
  suggestCategories,
  suggestSlots,
  findDuplicates,
  computeNextFire,
};
