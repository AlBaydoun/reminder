import { computeNextFire } from '../demo/engine';
import type { api as ServerApi } from '../serverApi';
import type { Drawing, Item, Reminder, User } from '../types';
import { clearMirror, loadMirror, mirrorNow, patchMirror, recordFromServer } from './mirror';
import { newTempId, pendingCount } from './outbox';
import {
  announce,
  countsFor,
  flushOutbox,
  isNetworkFailure,
  liveItems,
  localOverview,
  OfflineError,
  offlineState,
  onOfflineChange,
  read,
  setOnline,
  withItem,
  write,
} from './api';

/**
 * The same API surface, with the network treated as optional.
 *
 * Assigning the result to `typeof ServerApi` is the point: the compiler
 * refuses to let this drift from the real client, so a method added to the
 * server client cannot be quietly forgotten here and silently lose its offline
 * behaviour.
 */
/** Things to do once queued changes have reached the server. */
const afterSync = new Set<() => void>();

/** Run something after the queue drains — reloading the workspace, normally. */
export function onSynced(fn: () => void) {
  afterSync.add(fn);
  return () => afterSync.delete(fn);
}

export function offlineCapable(server: typeof ServerApi): typeof ServerApi {
  /**
   * Drain the queue, then tell the app to reload.
   *
   * The reload is not optional: a task created offline is still wearing a
   * temporary id until the server answers, and the interface should be showing
   * the real one — along with anything else that changed while we were away.
   */
  const resync = async () => {
    const result = await flushOutbox(server).catch(() => ({ sent: 0, failed: 0 }));
    if (result.sent > 0) for (const fn of afterSync) fn();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      setOnline(true);
      void resync();
    });
    window.addEventListener('offline', () => setOnline(false));
  }

  void loadMirror().then(() => {
    announce();
    // Anything left from a previous run goes out as soon as the app opens.
    if (navigator.onLine && pendingCount() > 0) void resync();
  });

  const nowIso = () => new Date().toISOString();

  /** A task made offline, shaped exactly like one the server would return. */
  function draftItem(input: Partial<Item> & { title: string }, id: string): Item {
    return {
      id,
      parentId: input.parentId ?? null,
      title: input.title,
      notes: input.notes ?? '',
      icon: input.icon ?? '',
      color: input.color ?? '',
      status: 'open',
      priority: input.priority ?? 3,
      energy: input.energy ?? 3,
      effortMinutes: input.effortMinutes ?? 0,
      dueAt: input.dueAt ?? null,
      startAt: input.startAt ?? null,
      recurrence: input.recurrence ?? null,
      tags: input.tags ?? [],
      blockedBy: input.blockedBy ?? [],
      meta: input.meta ?? {},
      position: input.position ?? 0,
      pinned: input.pinned ?? false,
      displayMode: input.displayMode ?? 'text',
      inkDrawingId: input.inkDrawingId ?? null,
      completedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      deletedAt: null,
    };
  }

  const api: typeof ServerApi = {
    ...server,

    // ── reads that must survive a lost connection ───────────────────────
    listItems: (includeDeleted = false) =>
      read(
        () => server.listItems(includeDeleted),
        (value) => recordFromServer({ items: value.items }),
        () => {
          const items = includeDeleted ? mirrorNow().items : liveItems();
          return { items, counts: countsFor(items) };
        },
      ),

    listReminders: () =>
      read(
        () => server.listReminders(),
        (value) => recordFromServer({ reminders: value }),
        () => mirrorNow().reminders,
      ),

    listDrawings: (itemId?: string) =>
      read(
        () => server.listDrawings(itemId),
        (value) => {
          // A filtered fetch is a slice, not the whole picture; merging keeps
          // the sketches the mirror already had.
          if (itemId) {
            patchMirror((state) => ({
              ...state,
              drawings: [...state.drawings.filter((d) => !value.some((v) => v.id === d.id)), ...value],
            }));
          } else {
            recordFromServer({ drawings: value });
          }
        },
        () => mirrorNow().drawings.filter((d) => (itemId ? d.itemId === itemId : true)),
      ),

    listSounds: () =>
      read(
        () => server.listSounds(),
        (value) => recordFromServer({ sounds: value.custom }),
        () => ({ builtin: [], custom: mirrorNow().sounds }),
      ),

    me: () =>
      read(
        () => server.me(),
        (value) => recordFromServer({ user: value }),
        () => {
          const user = mirrorNow().user;
          if (!user) throw new OfflineError();
          return user;
        },
      ),

    // ── reasoning, computed locally when it has to be ───────────────────
    overview: () => read(() => server.overview(), () => undefined, () => localOverview()),
    focus: (limit = 20, includeBlocked = false) =>
      read(
        () => server.focus(limit, includeBlocked),
        () => undefined,
        () => localOverview().focus.filter((s) => includeBlocked || !s.blocked).slice(0, limit),
      ),
    forecast: (days = 14) =>
      read(() => server.forecast(days), () => undefined, () => localOverview().forecast.slice(0, days)),

    dueReminders: (lookaheadMs = 0) =>
      read(
        () => server.dueReminders(lookaheadMs),
        () => undefined,
        () => ({
          due: mirrorNow()
            .reminders.filter(
              (r) =>
                r.status !== 'done' &&
                r.nextFireAt &&
                new Date(r.nextFireAt).getTime() <= Date.now() + lookaheadMs,
            )
            .map(withItem)
            .filter((r): r is NonNullable<typeof r> => r !== null),
          // Offline there is no server clock to trust, so the device's own is
          // reported as-is rather than pretending to an offset.
          serverTime: nowIso(),
        }),
      ),

    upcomingReminders: (hours = 24) =>
      read(
        () => server.upcomingReminders(hours),
        () => undefined,
        () => {
          const now = Date.now();
          const horizon = now + hours * 3_600_000;
          return {
            upcoming: mirrorNow()
              .reminders.filter((r) => {
                if (r.status === 'done' || !r.nextFireAt) return false;
                const at = new Date(r.nextFireAt).getTime();
                return at > now && at <= horizon;
              })
              .map(withItem)
              .filter((r): r is NonNullable<typeof r> => r !== null),
            serverTime: nowIso(),
          };
        },
      ),

    // ── writes ──────────────────────────────────────────────────────────
    createItem: (input) => {
      const tempId = newTempId();
      return write(
        'createItem',
        [input],
        () => server.createItem(input),
        () => {
          const item = draftItem(input, tempId);
          patchMirror((state) => ({ ...state, items: [...state.items, item] }));
          return item;
        },
        tempId,
      );
    },

    updateItem: (id, input) =>
      write(
        'updateItem',
        [id, input],
        () => server.updateItem(id, input),
        () => {
          let updated: Item | undefined;
          patchMirror((state) => ({
            ...state,
            items: state.items.map((item) => {
              if (item.id !== id) return item;
              updated = { ...item, ...input, updatedAt: nowIso() } as Item;
              return updated;
            }),
          }));
          if (!updated) throw new OfflineError();
          return updated;
        },
      ),

    completeItem: (id, done = true, cascade = false) =>
      write(
        'completeItem',
        [id, done, cascade],
        () => server.completeItem(id, done, cascade),
        () => {
          const at = nowIso();
          patchMirror((state) => ({
            ...state,
            items: state.items.map((item) =>
              item.id === id
                ? { ...item, status: done ? 'done' : 'open', completedAt: done ? at : null, updatedAt: at }
                : item,
            ),
          }));
          const item = mirrorNow().items.find((i) => i.id === id);
          if (!item) throw new OfflineError();
          return { item };
        },
      ),

    moveItem: (id, parentId, position) =>
      write(
        'moveItem',
        [id, parentId, position],
        () => server.moveItem(id, parentId, position),
        () => {
          patchMirror((state) => ({
            ...state,
            items: state.items.map((item) =>
              item.id === id ? { ...item, parentId, position: position ?? item.position, updatedAt: nowIso() } : item,
            ),
          }));
          const item = mirrorNow().items.find((i) => i.id === id);
          if (!item) throw new OfflineError();
          return item;
        },
      ),

    deleteItem: (id, hard = false) =>
      write(
        'deleteItem',
        [id, hard],
        () => server.deleteItem(id, hard),
        () => {
          const at = nowIso();
          const affected = [id];
          patchMirror((state) => ({
            ...state,
            items: hard
              ? state.items.filter((item) => item.id !== id)
              : state.items.map((item) => (item.id === id ? { ...item, deletedAt: at } : item)),
          }));
          return { ok: true, affected };
        },
      ),

    restoreItem: (id) =>
      write(
        'restoreItem',
        [id],
        () => server.restoreItem(id),
        () => {
          patchMirror((state) => ({
            ...state,
            items: state.items.map((item) => (item.id === id ? { ...item, deletedAt: null } : item)),
          }));
          return { ok: true };
        },
      ),

    reorderItems: (parentId, ids) =>
      write(
        'reorderItems',
        [parentId, ids],
        () => server.reorderItems(parentId, ids),
        () => {
          patchMirror((state) => ({
            ...state,
            items: state.items.map((item) => {
              const index = ids.indexOf(item.id);
              return index >= 0 ? { ...item, position: index } : item;
            }),
          }));
          return undefined as unknown as ReturnType<typeof server.reorderItems> extends Promise<infer R> ? R : never;
        },
      ),

    createReminder: (input) => {
      const tempId = newTempId();
      return write(
        'createReminder',
        [input],
        () => server.createReminder(input),
        () => {
          const reminder: Reminder = {
            id: tempId,
            itemId: input.itemId,
            label: input.label ?? '',
            fireAt: input.fireAt,
            nextFireAt: input.fireAt,
            rrule: input.rrule ?? null,
            soundId: input.soundId ?? 'builtin:chime',
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
          } as Reminder;
          patchMirror((state) => ({ ...state, reminders: [...state.reminders, reminder] }));
          return reminder;
        },
        tempId,
      );
    },

    updateReminder: (id, input) =>
      write(
        'updateReminder',
        [id, input],
        () => server.updateReminder(id, input),
        () => {
          let updated: Reminder | undefined;
          patchMirror((state) => ({
            ...state,
            reminders: state.reminders.map((reminder) => {
              if (reminder.id !== id) return reminder;
              const next = { ...reminder, ...input, updatedAt: nowIso() } as Reminder;
              // The next fire time is derived, so recompute it rather than
              // leaving a stale one the alarm engine would act on.
              next.nextFireAt = computeNextFire(next);
              updated = next;
              return next;
            }),
          }));
          if (!updated) throw new OfflineError();
          return updated;
        },
      ),

    deleteReminder: (id) =>
      write(
        'deleteReminder',
        [id],
        () => server.deleteReminder(id),
        () => {
          patchMirror((state) => ({
            ...state,
            reminders: state.reminders.filter((reminder) => reminder.id !== id),
          }));
          return { ok: true };
        },
      ),

    snoozeReminder: (id, minutes) =>
      write(
        'snoozeReminder',
        [id, minutes],
        () => server.snoozeReminder(id, minutes),
        () => {
          const reminder = mirrorNow().reminders.find((r) => r.id === id);
          const until = new Date(Date.now() + (minutes ?? reminder?.snoozeMinutes ?? 9) * 60_000).toISOString();
          patchMirror((state) => ({
            ...state,
            reminders: state.reminders.map((r) =>
              r.id === id ? { ...r, snoozedUntil: until, nextFireAt: until, status: 'snoozed' } : r,
            ),
          }));
          const updated = mirrorNow().reminders.find((r) => r.id === id);
          if (!updated) throw new OfflineError();
          return { reminder: updated, snoozedUntil: until };
        },
      ),

    dismissReminder: (id) =>
      write(
        'dismissReminder',
        [id],
        () => server.dismissReminder(id),
        () => {
          patchMirror((state) => ({
            ...state,
            reminders: state.reminders.map((r) => {
              if (r.id !== id) return r;
              const next = {
                ...r,
                status: r.rrule ? 'scheduled' : 'dismissed',
                snoozedUntil: null,
                lastFiredAt: nowIso(),
              } as Reminder;
              next.nextFireAt = computeNextFire(next);
              return next;
            }),
          }));
          const updated = mirrorNow().reminders.find((r) => r.id === id);
          if (!updated) throw new OfflineError();
          return updated;
        },
      ),

    createDrawing: (input) => {
      const tempId = newTempId();
      return write(
        'createDrawing',
        [input],
        () => server.createDrawing(input),
        () => {
          const drawing = {
            id: tempId,
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
          } as Drawing;
          patchMirror((state) => ({ ...state, drawings: [...state.drawings, drawing] }));
          return drawing;
        },
        tempId,
      );
    },

    updateDrawing: (id, input) =>
      write(
        'updateDrawing',
        [id, input],
        () => server.updateDrawing(id, input),
        () => {
          let updated: Drawing | undefined;
          patchMirror((state) => ({
            ...state,
            drawings: state.drawings.map((drawing) => {
              if (drawing.id !== id) return drawing;
              updated = { ...drawing, ...input, updatedAt: nowIso() } as Drawing;
              return updated;
            }),
          }));
          if (!updated) throw new OfflineError();
          return updated;
        },
      ),

    deleteDrawing: (id) =>
      write(
        'deleteDrawing',
        [id],
        () => server.deleteDrawing(id),
        () => {
          patchMirror((state) => ({ ...state, drawings: state.drawings.filter((d) => d.id !== id) }));
          return { ok: true };
        },
      ),

    /**
     * Getting back in with no connection.
     *
     * Restoring a session normally means exchanging the refresh cookie for a
     * token, which needs the server. Offline that call fails, the app decides
     * nobody is signed in, and shows a login screen — which is useless without
     * a network and throws away the whole point of working offline.
     *
     * So when the *network* is what failed, the mirrored user stands in. The
     * data is already on this device and readable regardless; refusing to
     * display it protects nothing. A real 401 is different and still signs the
     * person out, and signing out clears the mirror.
     */
    /**
     * Signing in is the moment the mirror learns who it belongs to.
     *
     * Without this the workspace is cached but the account is not, and the
     * next offline start has tasks to show and nobody to show them to — so it
     * falls back to a login screen that cannot be used without a network.
     */
    async signup(input) {
      const user = await server.signup(input);
      recordFromServer({ user });
      return user;
    },

    async login(input) {
      const user = await server.login(input);
      // A different account must never inherit the last one's workspace.
      const previous = mirrorNow().user;
      if (previous && previous.id !== user.id) await clearMirror();
      recordFromServer({ user });
      return user;
    },

    async restoreSession() {
      let user: Awaited<ReturnType<typeof server.restoreSession>> = null;
      try {
        user = await server.restoreSession();
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
      }
      if (user) {
        setOnline(true);
        recordFromServer({ user });
        return user;
      }

      // A null answer is ambiguous: the token exchange swallows a network
      // failure and reports "not signed in", which looks identical to a
      // genuinely expired session. Only one of those should show a login
      // screen, so ask whether the server is reachable at all before deciding.
      const mirrored = mirrorNow().user;
      if (!mirrored) return null;

      const reachable = await server
        .health()
        .then(() => true)
        .catch(() => false);
      if (reachable) {
        setOnline(true);
        return null; // the session really has expired
      }
      setOnline(false);
      return mirrored;
    },

    /** Settings changed offline are worth keeping, but are not queued work. */
    updateProfile: (patchBody) =>
      write(
        'updateItem',
        [],
        () => server.updateProfile(patchBody),
        () => {
          const user = mirrorNow().user;
          if (!user) throw new OfflineError();
          // `locale` arrives as a plain string from the caller's patch; the
          // server would have validated it, so narrow it back here.
          const updated: User = {
            ...user,
            ...patchBody,
            locale: (patchBody.locale as User['locale']) ?? user.locale,
            settings: { ...user.settings, ...patchBody.settings },
          };
          recordFromServer({ user: updated });
          return updated;
        },
      ),

    // Signing out is also the moment to forget the mirror: it holds one
    // account's workspace, and the next person to sign in must not see it.
    async logout() {
      try {
        await server.logout();
      } finally {
        await clearMirror();
        announce();
      }
    },
  };

  return api;
}

export { flushOutbox, offlineState, onOfflineChange, OfflineError };
export type { OfflineState } from './api';
export { clearOutbox } from './outbox';
export { pendingCount };
