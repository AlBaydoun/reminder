import { similarity } from '../text';
import type {
  BackupRecord,
  BatchOp,
  BuiltinSound,
  CanvasText,
  CustomSound,
  Drawing,
  DueReminder,
  Item,
  Overview,
  Reminder,
  Stroke,
  TargetRef,
  User,
  UserSettings,
} from '../types';
import {
  buildInsights,
  computeNextFire,
  dependencyReport,
  findDuplicates,
  nextOccurrence,
  scoreItems,
  streaks,
  suggestCategories,
  suggestSlots,
  workloadForecast,
} from './engine';
import {
  clearAll,
  deleteBlob,
  forgetSoundUrl,
  newId,
  nowIso,
  readState,
  registerSoundUrl,
  rehydrateSoundUrls,
  seedState,
  soundUrl,
  writeBlob,
  writeState,
  type DemoState,
} from './store';

/**
 * The demo backend.
 *
 * Implements exactly the surface of `serverApi.ts` against IndexedDB, so the
 * published static build behaves like the real thing without a server behind
 * it. Everything a visitor does stays in their own browser, and "sign out"
 * wipes it and re-seeds.
 *
 * What genuinely differs from the server build, and is stated in the UI rather
 * than papered over: there is no sync between devices, and the nightly backup
 * is a local snapshot taken when the app is open rather than a cron job.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// The demo has no tokens, but the app's auth plumbing expects these to exist.
const listeners = new Set<(signedIn: boolean) => void>();
let signedIn = false;
export function setAccessToken(token: string | null) {
  signedIn = Boolean(token);
  for (const fn of listeners) fn(signedIn);
}
export const getAccessToken = () => (signedIn ? 'demo' : null);
export function onAuthChange(fn: (signedIn: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let state: DemoState | null = null;
let loading: Promise<DemoState> | null = null;

async function load(): Promise<DemoState> {
  if (state) return state;
  if (!loading) {
    loading = (async () => {
      let stored: DemoState | undefined;
      try {
        stored = await readState();
      } catch {
        // Private-browsing modes can refuse IndexedDB entirely; fall back to
        // a session-only workspace rather than showing a broken app.
      }
      const next = stored ?? seedState();
      if (!stored) {
        try {
          await writeState(next);
        } catch {
          /* memory-only for this session */
        }
      }
      next.sounds = await rehydrateSoundUrls(next.sounds).catch(() => next.sounds);
      state = next;
      return next;
    })();
  }
  return loading;
}

async function save(): Promise<void> {
  if (!state) return;
  try {
    // Blob URLs are per-session and must not be persisted.
    await writeState({ ...state, sounds: state.sounds.map((s) => ({ ...s, url: '' })) });
  } catch {
    /* memory-only for this session */
  }
}

/** Simulate a little latency so loading states are exercised, not skipped. */
const settle = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 12));

const live = (s: DemoState) => s.items.filter((i) => !i.deletedAt);

function requireItem(s: DemoState, id: string): Item {
  const item = s.items.find((i) => i.id === id && !i.deletedAt);
  if (!item) throw new ApiError(404, 'Item not found', 'not_found');
  return item;
}

function descendants(s: DemoState, rootId: string): string[] {
  const byParent = new Map<string, Item[]>();
  for (const i of s.items) {
    if (!i.parentId) continue;
    byParent.set(i.parentId, [...(byParent.get(i.parentId) ?? []), i]);
  }
  const out: string[] = [];
  const queue = [...(byParent.get(rootId) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    out.push(next.id);
    queue.push(...(byParent.get(next.id) ?? []));
  }
  return out;
}

function wouldCycle(s: DemoState, id: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (parentId === id) return true;
  return descendants(s, id).includes(parentId);
}

function nextPosition(s: DemoState, parentId: string | null): number {
  const siblings = live(s).filter((i) => i.parentId === parentId);
  return siblings.reduce((max, i) => Math.max(max, i.position), 0) + 1000;
}

function log(s: DemoState, kind: string, itemId: string | null) {
  s.activity.unshift({ id: newId(), kind, itemId, createdAt: nowIso() });
  if (s.activity.length > 4000) s.activity.length = 4000;
}

function makeItem(s: DemoState, input: Partial<Item> & { title: string }): Item {
  const ts = nowIso();
  const parentId = input.parentId ?? null;
  const item: Item = {
    id: newId(),
    parentId,
    title: input.title,
    notes: input.notes ?? '',
    icon: input.icon ?? '',
    color: input.color ?? '',
    status: input.status ?? 'open',
    priority: input.priority ?? 2,
    energy: input.energy ?? 3,
    effortMinutes: input.effortMinutes ?? 0,
    dueAt: input.dueAt ?? null,
    startAt: input.startAt ?? null,
    recurrence: input.recurrence ?? null,
    tags: input.tags ?? [],
    blockedBy: input.blockedBy ?? [],
    meta: input.meta ?? {},
    position: input.position ?? nextPosition(s, parentId),
    pinned: input.pinned ?? false,
    displayMode: input.displayMode ?? 'text',
    inkDrawingId: input.inkDrawingId ?? null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: input.status === 'done' ? ts : null,
    deletedAt: null,
  };
  s.items.push(item);
  log(s, 'item.created', item.id);
  return item;
}

/**
 * Resolve a spoken path like ["cars", "corolla"], optionally creating the
 * segments that do not exist yet — the same forgiving matching the server does.
 */
function resolveParentPath(
  s: DemoState,
  segments: string[] | undefined,
  createMissing: boolean | undefined,
): string | null {
  const path = (segments ?? []).map((x) => x.trim()).filter(Boolean);
  if (!path.length) return null;

  let parentId: string | null = null;
  for (const segment of path) {
    const needle = segment.toLowerCase();
    const candidates = live(s).filter((i) => i.parentId === parentId);
    const exact = candidates.find((c) => c.title.toLowerCase() === needle);
    const partial = candidates.filter((c) => c.title.toLowerCase().includes(needle));
    const hit = exact ?? (partial.length === 1 ? partial[0] : undefined);

    if (hit) {
      parentId = hit.id;
      continue;
    }
    if (!createMissing) throw new ApiError(404, `No category matching "${path.join(' / ')}"`, 'not_found');
    parentId = makeItem(s, { title: segment, parentId }).id;
  }
  return parentId;
}

function resolveTarget(s: DemoState, ref: TargetRef, last: string | null): string {
  if (ref.useLast) {
    if (!last) throw new ApiError(400, 'Nothing was created earlier in this command to refer back to', 'bad_request');
    return last;
  }
  if (ref.id) return requireItem(s, ref.id).id;

  const query = ref.query?.trim();
  if (!query) throw new ApiError(400, 'No item was named', 'bad_request');

  const rows = live(s);
  const needle = query.toLowerCase();
  const exact = rows.find((r) => r.title.toLowerCase() === needle);
  if (exact) return exact.id;
  const contains = rows.filter((r) => r.title.toLowerCase().includes(needle));
  if (contains.length === 1) return contains[0].id;

  let best: { id: string; score: number } | null = null;
  for (const row of rows) {
    const score = similarity(row.title, query);
    if (!best || score > best.score) best = { id: row.id, score };
  }
  if (best && best.score >= 0.4) return best.id;
  throw new ApiError(404, `Could not find anything called "${query}"`, 'not_found');
}

function refreshReminder(s: DemoState, reminder: Reminder) {
  reminder.nextFireAt = computeNextFire(reminder);
  reminder.updatedAt = nowIso();
}

/**
 * Completing a repeating item rolls it forward instead of closing it — that is
 * what "every Monday" means to a person.
 */
function completeItem(s: DemoState, item: Item, done: boolean, cascade: boolean) {
  const ts = nowIso();

  if (done && item.recurrence) {
    const anchor = new Date(item.dueAt ?? item.createdAt);
    const next = nextOccurrence(item.recurrence, anchor, new Date());
    if (next) {
      item.dueAt = next.toISOString();
      item.completedAt = ts;
      item.updatedAt = ts;
      log(s, 'item.recurred', item.id);
      for (const r of s.reminders.filter((r) => r.itemId === item.id)) refreshReminder(s, r);
      return { item, rolledForwardTo: next.toISOString() };
    }
  }

  const ids = cascade ? [item.id, ...descendants(s, item.id)] : [item.id];
  for (const id of ids) {
    const target = s.items.find((i) => i.id === id);
    if (!target) continue;
    target.status = done ? 'done' : 'open';
    target.completedAt = done ? ts : null;
    target.updatedAt = ts;
  }
  log(s, done ? 'item.completed' : 'item.reopened', item.id);
  return { item, affected: ids };
}

const BUILTIN_SOUNDS: BuiltinSound[] = [
  { key: 'chime', name: 'Chime', character: 'gentle' },
  { key: 'marimba', name: 'Marimba', character: 'gentle' },
  { key: 'harp', name: 'Harp Rise', character: 'gentle' },
  { key: 'bells', name: 'Temple Bells', character: 'calm' },
  { key: 'pulse', name: 'Pulse', character: 'neutral' },
  { key: 'radar', name: 'Radar', character: 'urgent' },
  { key: 'siren', name: 'Siren', character: 'urgent' },
  { key: 'klaxon', name: 'Klaxon', character: 'urgent' },
  { key: 'digital', name: 'Digital Alarm', character: 'urgent' },
  { key: 'birdsong', name: 'Birdsong', character: 'gentle' },
  { key: 'water', name: 'Water Drop', character: 'calm' },
  { key: 'cosmic', name: 'Cosmic', character: 'neutral' },
];

function snapshot(s: DemoState) {
  return JSON.stringify({
    format: 'nexus-backup',
    version: 1,
    exportedAt: nowIso(),
    user: s.user,
    items: s.items,
    reminders: s.reminders,
    drawings: s.drawings,
    // Sound files themselves stay in IndexedDB; a demo export carries the list.
    sounds: s.sounds.map((x) => ({ ...x, url: '' })),
    activity: s.activity.slice(0, 2000),
    counts: {
      items: s.items.length,
      reminders: s.reminders.length,
      drawings: s.drawings.length,
      sounds: s.sounds.length,
    },
  });
}

function takeBackup(s: DemoState, kind: 'nightly' | 'manual' | 'pre-restore'): BackupRecord {
  const payload = snapshot(s);
  const record = {
    id: newId(),
    kind,
    filename: `nexus-${kind}-${nowIso().replace(/[:.]/g, '-')}.json`,
    size: new Blob([payload]).size,
    itemCount: s.items.length,
    createdAt: nowIso(),
    payload,
  };
  s.backups.unshift(record);
  // Keep the demo's storage bounded; the server keeps 30 nightly + 12 monthly.
  if (s.backups.length > 20) s.backups.length = 20;
  if (kind === 'nightly') s.lastNightlyAt = record.createdAt;
  return { ...record, available: true } as BackupRecord;
}

function restoreFrom(s: DemoState, payload: any, mode: 'replace' | 'merge') {
  if (payload?.format !== 'nexus-backup') throw new ApiError(400, 'That is not a Nexus backup file', 'bad_request');
  takeBackup(s, 'pre-restore');

  if (mode === 'replace') {
    s.items = [];
    s.reminders = [];
    s.drawings = [];
  }
  const mergeById = <T extends { id: string }>(current: T[], incoming: T[]): T[] => {
    const map = new Map(current.map((x) => [x.id, x]));
    for (const row of incoming ?? []) map.set(row.id, row);
    return [...map.values()];
  };

  s.items = mergeById(s.items, payload.items ?? []);
  s.reminders = mergeById(s.reminders, payload.reminders ?? []);
  s.drawings = mergeById(s.drawings, payload.drawings ?? []);
  if (payload.user?.settings) s.user = { ...s.user, settings: { ...s.user.settings, ...payload.user.settings } };
  for (const reminder of s.reminders) refreshReminder(s, reminder);

  return {
    items: (payload.items ?? []).length,
    reminders: (payload.reminders ?? []).length,
    drawings: (payload.drawings ?? []).length,
    sounds: (payload.sounds ?? []).length,
  };
}

/** Attach the item each due reminder belongs to, as the server's endpoint does. */
function withItem(s: DemoState, reminder: Reminder): DueReminder | null {
  const item = s.items.find((i) => i.id === reminder.itemId && !i.deletedAt);
  if (!item) return null;
  return {
    ...reminder,
    item: { id: item.id, title: item.title, icon: item.icon, color: item.color, status: item.status },
  };
}

export const api = {
  // ── auth ────────────────────────────────────────────────────────────────
  async signup(input: { email: string; password: string; name?: string; locale?: string; timezone?: string }) {
    const s = await load();
    s.user = {
      ...s.user,
      email: input.email,
      name: input.name || input.email.split('@')[0],
      locale: (input.locale as User['locale']) ?? s.user.locale,
      timezone: input.timezone ?? s.user.timezone,
    };
    await save();
    setAccessToken('demo');
    return settle(s.user);
  },

  async login(_input: { email: string; password: string }) {
    const s = await load();
    setAccessToken('demo');
    return settle(s.user);
  },

  /** The demo opens straight into the workspace — there is nobody to sign in as. */
  async restoreSession(): Promise<User | null> {
    const s = await load();
    setAccessToken('demo');
    return settle(s.user);
  },

  /** In the demo this means "reset": wipe this browser's copy and re-seed. */
  async logout(): Promise<void> {
    await clearAll();
    state = null;
    loading = null;
    await load();
    setAccessToken('demo');
  },

  async me() {
    return settle((await load()).user);
  },

  async updateProfile(patch: { name?: string; locale?: string; timezone?: string; settings?: UserSettings }) {
    const s = await load();
    s.user = {
      ...s.user,
      name: patch.name ?? s.user.name,
      locale: (patch.locale as User['locale']) ?? s.user.locale,
      timezone: patch.timezone ?? s.user.timezone,
      settings: patch.settings ? { ...s.user.settings, ...patch.settings } : s.user.settings,
    };
    await save();
    return settle(s.user);
  },

  async changePassword() {
    throw new ApiError(400, 'The demo has no password — your data lives in this browser only', 'bad_request');
  },

  // ── items ───────────────────────────────────────────────────────────────
  async listItems() {
    const s = await load();
    const counts: Record<string, { total: number; done: number }> = {};
    for (const item of live(s)) {
      if (!item.parentId) continue;
      const entry = (counts[item.parentId] ??= { total: 0, done: 0 });
      entry.total++;
      if (item.status === 'done') entry.done++;
    }
    return settle({ items: [...s.items], counts });
  },

  async getItem(id: string) {
    const s = await load();
    const item = requireItem(s, id);
    const path: string[] = [];
    let cursor: Item | undefined = item;
    while (cursor) {
      path.unshift(cursor.id);
      cursor = cursor.parentId ? s.items.find((i) => i.id === cursor!.parentId) : undefined;
    }
    return settle({ item, children: live(s).filter((i) => i.parentId === id), path });
  },

  async createItem(input: Partial<Item> & { title: string; parentPath?: string[]; createMissingPath?: boolean }) {
    const s = await load();
    const parentId =
      input.parentId !== undefined && input.parentId !== null
        ? requireItem(s, input.parentId).id
        : (resolveParentPath(s, input.parentPath, input.createMissingPath) ?? null);
    const item = makeItem(s, { ...input, parentId });
    await save();
    return settle(item);
  },

  async updateItem(id: string, patch: Partial<Item>) {
    const s = await load();
    const item = requireItem(s, id);
    if (patch.parentId !== undefined && wouldCycle(s, id, patch.parentId)) {
      throw new ApiError(400, 'Cannot move an item inside one of its own children', 'bad_request');
    }
    Object.assign(item, patch, { updatedAt: nowIso() });
    if (patch.status !== undefined) {
      item.completedAt = patch.status === 'done' ? (item.completedAt ?? nowIso()) : null;
    }
    if (patch.meta) item.meta = { ...item.meta, ...patch.meta };
    await save();
    return settle(item);
  },

  async completeItem(id: string, done = true, cascade = false) {
    const s = await load();
    const result = completeItem(s, requireItem(s, id), done, cascade);
    await save();
    return settle(result);
  },

  async moveItem(id: string, parentId: string | null, position?: number) {
    const s = await load();
    const item = requireItem(s, id);
    if (wouldCycle(s, id, parentId)) {
      throw new ApiError(400, 'Cannot move an item inside one of its own children', 'bad_request');
    }
    item.parentId = parentId;
    item.position = position ?? nextPosition(s, parentId);
    item.updatedAt = nowIso();
    await save();
    return settle(item);
  },

  async reorderItems(parentId: string | null, ids: string[]) {
    const s = await load();
    ids.forEach((id, index) => {
      const item = s.items.find((i) => i.id === id);
      if (!item) return;
      item.parentId = parentId;
      item.position = index * 1000;
      item.updatedAt = nowIso();
    });
    await save();
    return settle({ ok: true });
  },

  async deleteItem(id: string, hard = false) {
    const s = await load();
    const ids = [id, ...descendants(s, id)];
    if (hard) {
      s.items = s.items.filter((i) => !ids.includes(i.id));
      s.reminders = s.reminders.filter((r) => !ids.includes(r.itemId));
    } else {
      const ts = nowIso();
      for (const item of s.items) if (ids.includes(item.id)) item.deletedAt = ts;
    }
    log(s, hard ? 'item.purged' : 'item.deleted', id);
    await save();
    return settle({ ok: true, affected: ids });
  },

  async restoreItem(id: string) {
    const s = await load();
    const ids = [id, ...descendants(s, id)];
    for (const item of s.items) if (ids.includes(item.id)) item.deletedAt = null;
    // A restored child whose parent is still in the trash would vanish from the
    // tree, so lift it to the root instead of leaving it unreachable.
    const item = s.items.find((i) => i.id === id);
    if (item?.parentId) {
      const parent = s.items.find((i) => i.id === item.parentId);
      if (!parent || parent.deletedAt) item.parentId = null;
    }
    await save();
    return settle({ ok: true });
  },

  // ── reminders ───────────────────────────────────────────────────────────
  async listReminders() {
    const s = await load();
    return settle([...s.reminders]);
  },

  async dueReminders(lookaheadMs = 0) {
    const s = await load();
    const horizon = Date.now() + lookaheadMs;
    const due = s.reminders
      .filter((r) => r.status !== 'done' && r.nextFireAt && new Date(r.nextFireAt).getTime() <= horizon)
      .map((r) => withItem(s, r))
      .filter((r): r is DueReminder => Boolean(r));
    return settle({ due, serverTime: nowIso() });
  },

  async upcomingReminders(hours = 24) {
    const s = await load();
    const now = Date.now();
    const horizon = now + hours * 3_600_000;
    const upcoming = s.reminders
      .filter((r) => {
        if (r.status === 'done' || !r.nextFireAt) return false;
        const at = new Date(r.nextFireAt).getTime();
        return at > now && at <= horizon;
      })
      .map((r) => withItem(s, r))
      .filter((r): r is DueReminder => Boolean(r));
    return settle({ upcoming, serverTime: nowIso() });
  },

  async createReminder(input: Partial<Reminder> & { itemId: string; fireAt: string }) {
    const s = await load();
    requireItem(s, input.itemId);
    const reminder: Reminder = {
      id: newId(),
      itemId: input.itemId,
      label: input.label ?? '',
      fireAt: input.fireAt,
      nextFireAt: input.fireAt,
      rrule: input.rrule ?? null,
      soundId: input.soundId ?? null,
      volume: input.volume ?? 0.9,
      vibrate: input.vibrate ?? true,
      leadMinutes: input.leadMinutes ?? [],
      snoozeMinutes: input.snoozeMinutes ?? 9,
      snoozedUntil: null,
      escalate: input.escalate ?? false,
      ringSeconds: input.ringSeconds ?? 60,
      status: 'scheduled',
      lastFiredAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    refreshReminder(s, reminder);
    s.reminders.push(reminder);
    await save();
    return settle(reminder);
  },

  async updateReminder(id: string, patch: Partial<Reminder>) {
    const s = await load();
    const reminder = s.reminders.find((r) => r.id === id);
    if (!reminder) throw new ApiError(404, 'Reminder not found', 'not_found');
    Object.assign(reminder, patch);
    // Changing the time re-arms a reminder that had already gone off.
    if (patch.fireAt) {
      reminder.status = 'scheduled';
      reminder.snoozedUntil = null;
      reminder.lastFiredAt = null;
    }
    refreshReminder(s, reminder);
    await save();
    return settle(reminder);
  },

  async markReminderFired(id: string) {
    const s = await load();
    const reminder = s.reminders.find((r) => r.id === id);
    if (!reminder) throw new ApiError(404, 'Reminder not found', 'not_found');
    reminder.lastFiredAt = nowIso();
    reminder.status = 'fired';
    reminder.snoozedUntil = null;
    refreshReminder(s, reminder);
    log(s, 'reminder.fired', reminder.itemId);
    await save();
    return settle(reminder);
  },

  async snoozeReminder(id: string, minutes?: number) {
    const s = await load();
    const reminder = s.reminders.find((r) => r.id === id);
    if (!reminder) throw new ApiError(404, 'Reminder not found', 'not_found');
    const snoozedUntil = new Date(Date.now() + (minutes ?? reminder.snoozeMinutes) * 60_000).toISOString();
    reminder.snoozedUntil = snoozedUntil;
    reminder.status = 'snoozed';
    refreshReminder(s, reminder);
    await save();
    return settle({ reminder, snoozedUntil });
  },

  async dismissReminder(id: string) {
    const s = await load();
    const reminder = s.reminders.find((r) => r.id === id);
    if (!reminder) throw new ApiError(404, 'Reminder not found', 'not_found');
    // A repeating reminder is only dismissed for this occurrence.
    reminder.status = reminder.rrule ? 'scheduled' : 'dismissed';
    reminder.snoozedUntil = null;
    reminder.lastFiredAt = nowIso();
    refreshReminder(s, reminder);
    await save();
    return settle(reminder);
  },

  async deleteReminder(id: string) {
    const s = await load();
    s.reminders = s.reminders.filter((r) => r.id !== id);
    await save();
    return settle({ ok: true });
  },

  async resyncReminders() {
    const s = await load();
    for (const reminder of s.reminders) refreshReminder(s, reminder);
    await save();
    return settle({ ok: true, rescheduled: s.reminders.length });
  },

  // ── sounds ──────────────────────────────────────────────────────────────
  async listSounds() {
    const s = await load();
    return settle({ builtin: BUILTIN_SOUNDS, custom: [...s.sounds] });
  },

  async uploadSound(file: File, name?: string) {
    const s = await load();
    const id = newId();
    await writeBlob(id, file);
    const sound: CustomSound = {
      id,
      name: name || file.name.replace(/\.[^.]+$/, ''),
      mime: file.type || 'audio/mpeg',
      size: file.size,
      createdAt: nowIso(),
      url: registerSoundUrl(id, file),
    };
    s.sounds.unshift(sound);
    await save();
    return settle(sound);
  },

  async renameSound(id: string, name: string) {
    const s = await load();
    const sound = s.sounds.find((x) => x.id === id);
    if (sound) sound.name = name;
    await save();
    return settle({ ok: true });
  },

  async deleteSound(id: string) {
    const s = await load();
    s.sounds = s.sounds.filter((x) => x.id !== id);
    // Reminders pointing at it fall back to the default tone rather than going silent.
    for (const reminder of s.reminders) if (reminder.soundId === id) reminder.soundId = null;
    forgetSoundUrl(id);
    await deleteBlob(id).catch(() => undefined);
    await save();
    return settle({ ok: true });
  },

  // ── drawings ────────────────────────────────────────────────────────────
  async listDrawings(itemId?: string) {
    const s = await load();
    return settle(itemId ? s.drawings.filter((d) => d.itemId === itemId) : [...s.drawings]);
  },

  async createDrawing(input: {
    itemId?: string | null;
    title?: string;
    strokes: Stroke[];
    texts?: CanvasText[];
    width: number;
    height: number;
    thumbnail?: string;
    recognizedText?: string;
  }) {
    const s = await load();
    const drawing: Drawing = {
      id: newId(),
      itemId: input.itemId ?? null,
      title: input.title ?? '',
      strokes: input.strokes,
      texts: input.texts ?? [],
      width: input.width,
      height: input.height,
      thumbnail: input.thumbnail ?? '',
      recognizedText: input.recognizedText ?? '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    s.drawings.unshift(drawing);
    await save();
    return settle(drawing);
  },

  async updateDrawing(id: string, patch: Partial<Drawing>) {
    const s = await load();
    const drawing = s.drawings.find((d) => d.id === id);
    if (!drawing) throw new ApiError(404, 'Drawing not found', 'not_found');
    Object.assign(drawing, patch, { updatedAt: nowIso() });
    await save();
    return settle(drawing);
  },

  async deleteDrawing(id: string) {
    const s = await load();
    s.drawings = s.drawings.filter((d) => d.id !== id);
    await save();
    return settle({ ok: true });
  },

  // ── reasoning ───────────────────────────────────────────────────────────
  async overview(): Promise<Overview> {
    const s = await load();
    const now = new Date();
    const capacity = Number(s.user.settings.dailyCapacityMinutes) || 240;
    const scored = scoreItems(s.items, now.getTime());
    return settle({
      focus: scored.slice(0, 25),
      insights: buildInsights(s.items, s.activity, capacity, now),
      forecast: workloadForecast(s.items, capacity, 14, now),
      streak: streaks(s.activity, now),
      dependencies: dependencyReport(s.items),
      totals: {
        open: scored.length,
        blocked: scored.filter((x) => x.blocked).length,
        overdue: scored.filter((x) => x.item.dueAt && new Date(x.item.dueAt) < now).length,
      },
      timeZone: s.user.timezone,
      serverTime: now.toISOString(),
    });
  },

  async focus(limit = 20, includeBlocked = false) {
    const s = await load();
    const scored = scoreItems(s.items);
    return settle((includeBlocked ? scored : scored.filter((x) => !x.blocked)).slice(0, limit));
  },

  async forecast(days = 14) {
    const s = await load();
    return settle(workloadForecast(s.items, Number(s.user.settings.dailyCapacityMinutes) || 240, days));
  },

  async duplicates() {
    const s = await load();
    return settle(findDuplicates(s.items));
  },

  async categorize(title: string) {
    const s = await load();
    return settle(suggestCategories(s.items, title));
  },

  async suggestSlots(effortMinutes: number, days = 7) {
    const s = await load();
    return settle(
      suggestSlots(s.items, effortMinutes, {
        workStartHour: Number(s.user.settings.workStartHour ?? 9),
        workEndHour: Number(s.user.settings.workEndHour ?? 19),
        capacity: Number(s.user.settings.dailyCapacityMinutes) || 240,
        days,
      }),
    );
  },

  async search(q: string) {
    const s = await load();
    const needle = q.trim().toLowerCase();
    if (!needle) return settle([]);
    const inkText = new Map<string, string>();
    for (const drawing of s.drawings) {
      if (!drawing.itemId || !drawing.recognizedText) continue;
      inkText.set(drawing.itemId, `${inkText.get(drawing.itemId) ?? ''} ${drawing.recognizedText}`);
    }

    return settle(
      live(s)
        .filter(
          (i) =>
            i.title.toLowerCase().includes(needle) ||
            i.notes.toLowerCase().includes(needle) ||
            i.tags.some((t) => t.toLowerCase().includes(needle)) ||
            (inkText.get(i.id) ?? '').toLowerCase().includes(needle),
        )
        .slice(0, 60)
        .map((i) => ({
          id: i.id,
          title: i.title,
          icon: i.icon,
          color: i.color,
          parentId: i.parentId,
          status: i.status,
          dueAt: i.dueAt,
          tags: i.tags,
          displayMode: i.displayMode,
          inkDrawingId: i.inkDrawingId,
          snippet: i.notes.slice(0, 160),
        })),
    );
  },

  // ── voice batch ─────────────────────────────────────────────────────────
  async runBatch(ops: BatchOp[]) {
    const s = await load();
    const results: unknown[] = [];
    const inverse: any[] = [];
    let lastItemId: string | null = null;

    for (const op of ops) {
      switch (op.op) {
        case 'create_item': {
          const parentId =
            op.parentId !== undefined && op.parentId !== null
              ? requireItem(s, op.parentId).id
              : (resolveParentPath(s, op.parentPath, op.createMissingPath) ?? null);
          const item = makeItem(s, { ...op, parentId });
          lastItemId = item.id;
          inverse.unshift({ op: 'hard_delete_item', id: item.id });
          results.push({ op: op.op, item });
          break;
        }
        case 'complete_item': {
          const id = resolveTarget(s, op.target, lastItemId);
          const item = requireItem(s, id);
          inverse.unshift({
            op: 'restore_status',
            id,
            status: item.status,
            dueAt: item.dueAt,
            completedAt: item.completedAt,
          });
          const result = completeItem(s, item, op.done ?? true, op.cascade ?? false);
          lastItemId = id;
          results.push({ op: op.op, ...result });
          break;
        }
        case 'delete_item': {
          const id = resolveTarget(s, op.target, lastItemId);
          const item = requireItem(s, id);
          item.deletedAt = nowIso();
          inverse.unshift({ op: 'undelete_item', id });
          results.push({ op: op.op, id });
          break;
        }
        case 'update_item': {
          const id = resolveTarget(s, op.target, lastItemId);
          const item = requireItem(s, id);
          inverse.unshift({ op: 'restore_fields', id, fields: { ...item } });
          const { op: _op, target: _target, ...patch } = op;
          Object.assign(item, patch, { updatedAt: nowIso() });
          lastItemId = id;
          results.push({ op: op.op, item });
          break;
        }
        case 'move_item': {
          const id = resolveTarget(s, op.target, lastItemId);
          const item = requireItem(s, id);
          const parentId =
            op.parentId !== undefined && op.parentId !== null
              ? requireItem(s, op.parentId).id
              : (resolveParentPath(s, op.parentPath, op.createMissingPath) ?? null);
          if (wouldCycle(s, id, parentId)) {
            throw new ApiError(400, 'Cannot move an item inside one of its own children', 'bad_request');
          }
          inverse.unshift({ op: 'restore_parent', id, parentId: item.parentId });
          item.parentId = parentId;
          item.updatedAt = nowIso();
          lastItemId = id;
          results.push({ op: op.op, item });
          break;
        }
        case 'create_reminder': {
          const itemId = resolveTarget(s, op.target, lastItemId);
          const reminder: Reminder = {
            id: newId(),
            itemId,
            label: op.label ?? '',
            fireAt: op.fireAt,
            nextFireAt: op.fireAt,
            rrule: op.rrule ?? null,
            soundId: op.soundId ?? null,
            volume: 0.9,
            vibrate: true,
            leadMinutes: op.leadMinutes ?? [],
            snoozeMinutes: 9,
            snoozedUntil: null,
            escalate: op.escalate ?? false,
            ringSeconds: 60,
            status: 'scheduled',
            lastFiredAt: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          refreshReminder(s, reminder);
          s.reminders.push(reminder);
          lastItemId = itemId;
          inverse.unshift({ op: 'hard_delete_reminder', id: reminder.id });
          results.push({ op: op.op, reminder });
          break;
        }
      }
    }

    const undoId = newId();
    s.undo[undoId] = inverse;
    // Only the last few batches stay undoable, which is all the UI offers.
    const keys = Object.keys(s.undo);
    if (keys.length > 20) delete s.undo[keys[0]];

    await save();
    return settle({ results, undoId, applied: ops.length });
  },

  async undoBatch(undoId: string) {
    const s = await load();
    const inverse = (s.undo[undoId] as any[]) ?? null;
    if (!inverse) throw new ApiError(404, 'Nothing to undo', 'not_found');

    for (const step of inverse) {
      switch (step.op) {
        case 'hard_delete_item':
          s.items = s.items.filter((i) => i.id !== step.id);
          break;
        case 'hard_delete_reminder':
          s.reminders = s.reminders.filter((r) => r.id !== step.id);
          break;
        case 'undelete_item': {
          const item = s.items.find((i) => i.id === step.id);
          if (item) item.deletedAt = null;
          break;
        }
        case 'restore_status': {
          const item = s.items.find((i) => i.id === step.id);
          if (item) Object.assign(item, { status: step.status, dueAt: step.dueAt, completedAt: step.completedAt });
          break;
        }
        case 'restore_parent': {
          const item = s.items.find((i) => i.id === step.id);
          if (item) item.parentId = step.parentId ?? null;
          break;
        }
        case 'restore_fields': {
          const index = s.items.findIndex((i) => i.id === step.id);
          if (index >= 0) s.items[index] = step.fields;
          break;
        }
      }
    }
    delete s.undo[undoId];
    await save();
    return settle({ ok: true, reverted: inverse.length });
  },

  // ── backups ─────────────────────────────────────────────────────────────
  async listBackups() {
    const s = await load();
    return settle({
      backups: s.backups.map((b) => ({
        id: b.id,
        kind: b.kind,
        filename: b.filename,
        size: b.size,
        itemCount: b.itemCount,
        createdAt: b.createdAt,
        available: true,
      })) as BackupRecord[],
      lastNightly: s.lastNightlyAt,
    });
  },

  async createBackup() {
    const s = await load();
    const backup = takeBackup(s, 'manual');
    await save();
    return settle({ backup });
  },

  async restoreBackup(id: string, mode: 'replace' | 'merge' = 'replace') {
    const s = await load();
    const backup = s.backups.find((b) => b.id === id);
    if (!backup) throw new ApiError(404, 'Backup not found', 'not_found');
    const restored = restoreFrom(s, JSON.parse(backup.payload), mode);
    await save();
    return settle({ ok: true, restored, safetyBackup: 'pre-restore' });
  },

  async deleteBackup(id: string) {
    const s = await load();
    s.backups = s.backups.filter((b) => b.id !== id);
    await save();
    return settle({ ok: true });
  },

  async runNightlyBackup() {
    const s = await load();
    takeBackup(s, 'nightly');
    await save();
    return settle({ ok: true, users: 1, removed: 0 });
  },

  async importBackup(file: File, mode: 'replace' | 'merge' = 'replace') {
    const s = await load();
    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new ApiError(400, 'That file is not valid JSON', 'bad_request');
    }
    const restored = restoreFrom(s, payload, mode);
    await save();
    return settle({ ok: true, restored });
  },

  /** Rendered as an `<a download>`, so this has to be a synchronous URL. */
  exportUrl(): string {
    if (!state) return '#';
    return URL.createObjectURL(new Blob([snapshot(state)], { type: 'application/json' }));
  },

  backupDownloadUrl(id: string): string {
    const backup = state?.backups.find((b) => b.id === id);
    if (!backup) return '#';
    return URL.createObjectURL(new Blob([backup.payload], { type: 'application/json' }));
  },

  async health() {
    return settle({ ok: true, serverTime: nowIso(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  },
};

/** Lets the audio player resolve an uploaded sound without a server. */
export const demoSoundUrl = soundUrl;
