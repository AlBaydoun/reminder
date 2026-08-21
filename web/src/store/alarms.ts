import { create } from 'zustand';
import { api } from '../lib/api';
import { playSound, vibrate, type PlayHandle } from '../lib/audio/player';
import { isNative } from '../lib/native/bridge';
import {
  cancelNativeAlarm,
  clearAllNativeAlarms,
  syncNativeAlarms,
  type AlarmStrings,
} from '../lib/native/alarms';
import { attachNativeListeners, detachNativeListeners } from '../lib/native/listeners';
import type { DueReminder } from '../lib/types';
import { useData } from './data';
import { useUi } from './ui';

/**
 * The alarm engine.
 *
 * Design notes worth knowing:
 * - A one-second ticker drives firing, not `setTimeout` per alarm. Long
 *   timeouts are throttled in background tabs and are wrong after the device
 *   sleeps; comparing wall-clock time every second is immune to both.
 * - The server owns *when* an alarm is due, and reports its own clock with
 *   every poll. The offset is applied locally so a wrong device clock cannot
 *   fire alarms early or late.
 * - Several alarms can ring at once. Each keeps its own audio handle, so
 *   dismissing one does not silence the others.
 * - An alarm whose time passed while the app was closed still rings on the
 *   next open. Silently swallowing a missed alarm is the worst thing this
 *   app could do.
 */

const POLL_MS = 30_000;
const TICK_MS = 1000;
/**
 * How far ahead alarms are pre-armed. It has to exceed the longest pre-alert
 * the UI offers (one day), or a "warn me a day before" would never get the
 * chance to fire.
 */
const LOOKAHEAD_HOURS = 48;

export interface RingingAlarm {
  reminder: DueReminder;
  startedAt: number;
  /** True when the alarm fired while the app was closed. */
  missed: boolean;
}

interface AlarmState {
  armed: DueReminder[];
  ringing: RingingAlarm[];
  leadAlertsSent: string[];
  serverOffsetMs: number;
  running: boolean;
  notificationsGranted: boolean;

  start(): void;
  stop(): void;
  sync(): Promise<void>;
  requestNotifications(): Promise<boolean>;
  snooze(reminderId: string, minutes?: number): Promise<void>;
  dismiss(reminderId: string): Promise<void>;
  completeFromAlarm(reminderId: string): Promise<void>;
  stopAllSound(): void;
  /** Fire an alarm immediately — used by the "preview" button in settings. */
  testRing(reminder: DueReminder): void;
}

const handles = new Map<string, PlayHandle>();
const autoStopTimers = new Map<string, number>();
const vibrateTimers = new Map<string, number>();
let tickTimer: number | undefined;
let pollTimer: number | undefined;

function clearAudio(reminderId: string) {
  handles.get(reminderId)?.stop();
  handles.delete(reminderId);
  const stopTimer = autoStopTimers.get(reminderId);
  if (stopTimer !== undefined) window.clearTimeout(stopTimer);
  autoStopTimers.delete(reminderId);
  const vibrateTimer = vibrateTimers.get(reminderId);
  if (vibrateTimer !== undefined) window.clearInterval(vibrateTimer);
  vibrateTimers.delete(reminderId);
}

/**
 * Show an alarm as a system notification, with the two buttons a person
 * actually wants at that moment. Action buttons only exist on service-worker
 * notifications, which is another reason to prefer them over the constructor —
 * they also survive the tab being closed.
 */
function showNotification(reminder: DueReminder, body: string, withActions = true) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const t = useUi.getState().t;

  try {
    const options: NotificationOptions & {
      renotify?: boolean;
      vibrate?: number[];
      actions?: Array<{ action: string; title: string }>;
    } = {
      body,
      tag: `nexus-${reminder.id}`,
      renotify: true,
      // An escalating alarm must stay on screen until it is dealt with.
      requireInteraction: reminder.escalate,
      icon: `${import.meta.env.BASE_URL}icon-192.png`,
      badge: `${import.meta.env.BASE_URL}icon-192.png`,
      vibrate: reminder.vibrate ? [400, 200, 400] : undefined,
      data: { reminderId: reminder.id, itemId: reminder.itemId },
      ...(withActions
        ? {
            actions: [
              { action: 'snooze', title: t('reminder.snoozeFor', { n: reminder.snoozeMinutes }) },
              { action: 'done', title: t('reminder.markDone') },
            ],
          }
        : {}),
    };

    void navigator.serviceWorker?.ready
      .then((registration) => registration.showNotification(reminder.item.title || reminder.label, options))
      .catch(() => {
        // No service worker (or it failed): a plain notification still gets
        // attention, it just cannot carry buttons.
        const { actions, ...plain } = options;
        new Notification(reminder.item.title || reminder.label, plain);
      });
  } catch {
    /* notifications are a bonus, never a requirement */
  }
}

/** Close any system notification still showing for a reminder. */
function clearNotification(reminderId: string) {
  void navigator.serviceWorker?.ready
    .then((registration) => registration.getNotifications({ tag: `nexus-${reminderId}` }))
    .then((list) => list?.forEach((n) => n.close()))
    .catch(() => undefined);
}

export const useAlarms = create<AlarmState>((set, get) => ({
  armed: [],
  ringing: [],
  leadAlertsSent: [],
  serverOffsetMs: 0,
  running: false,
  notificationsGranted: typeof Notification !== 'undefined' && Notification.permission === 'granted',

  start() {
    if (get().running) return;
    set({ running: true });
    void get().sync();

    pollTimer = window.setInterval(() => void get().sync(), POLL_MS);
    tickTimer = window.setInterval(() => tick(set, get), TICK_MS);

    // Coming back to the tab (or waking the device) re-checks immediately —
    // the ticker may have been throttled to a crawl while hidden.
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onVisibility);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);

    // The phone equivalent of the service-worker messages above: a Snooze or
    // Done pressed on a notification, including one that launched the app.
    if (isNative()) {
      void attachNativeListeners({
        onAction: (action, reminderId) => void runAlarmAction(action, reminderId),
        onReceived: (reminderId) => {
          // The OS is already making the noise; this raises the screen that
          // lets it be acted on, without a second sound on top.
          const known = get().armed.find((r) => r.id === reminderId);
          if (known && !get().ringing.some((r) => r.reminder.id === reminderId)) {
            ring(known, set, get, false);
          }
        },
        onResume: () => void get().sync(),
      });
    }

    // A notification button pressed while the app was closed opens it with the
    // action in the URL; carry it out now and tidy the address bar.
    const params = new URLSearchParams(window.location.search);
    const pending = params.get('alarmAction');
    const reminderId = params.get('reminder');
    if (pending && reminderId) {
      void runAlarmAction(pending, reminderId);
      params.delete('alarmAction');
      params.delete('reminder');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  },

  stop() {
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
    if (tickTimer !== undefined) window.clearInterval(tickTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onVisibility);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    detachNativeListeners();
    get().stopAllSound();
    if (isNative()) void clearAllNativeAlarms();
    set({ running: false, armed: [], ringing: [] });
  },

  async sync() {
    try {
      const [upcoming, due] = await Promise.all([
        api.upcomingReminders(LOOKAHEAD_HOURS),
        api.dueReminders(0),
      ]);
      const serverTime = new Date(upcoming.serverTime).getTime();
      const offset = serverTime - Date.now();

      set({
        armed: upcoming.upcoming,
        // Guard against a badly wrong device clock, but ignore small jitter.
        serverOffsetMs: Math.abs(offset) > 2000 ? offset : 0,
      });

      // On a phone the operating system, not this ticker, is what actually
      // rings — the app will not be running when the alarm is due. Handing it
      // the schedule after every poll is what makes a closed-app alarm work.
      if (isNative()) void syncNativeAlarms(upcoming.upcoming, alarmStrings());

      // Anything already due when we polled fired while we were away.
      for (const reminder of due.due) {
        if (get().ringing.some((r) => r.reminder.id === reminder.id)) continue;
        ring(reminder, set, get, true);
      }
    } catch {
      /* offline — the ticker keeps firing from the last known schedule */
    }
  },

  async requestNotifications() {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') {
      set({ notificationsGranted: true });
      return true;
    }
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    const granted = result === 'granted';
    set({ notificationsGranted: granted });
    return granted;
  },

  async snooze(reminderId, minutes) {
    clearAudio(reminderId);
    clearNotification(reminderId);
    void clearNativeFor(reminderId, get);
    set((state) => ({ ringing: state.ringing.filter((r) => r.reminder.id !== reminderId) }));
    try {
      const { snoozedUntil } = await api.snoozeReminder(reminderId, minutes);
      const ui = useUi.getState();
      ui.toast(
        ui.t('reminder.snoozedUntil', { when: new Date(snoozedUntil).toLocaleTimeString() }),
        'info',
      );
    } catch {
      useUi.getState().toast(useUi.getState().t('error.generic'), 'error');
    }
    await get().sync();
  },

  async dismiss(reminderId) {
    clearAudio(reminderId);
    clearNotification(reminderId);
    void clearNativeFor(reminderId, get);
    set((state) => ({ ringing: state.ringing.filter((r) => r.reminder.id !== reminderId) }));
    try {
      await api.dismissReminder(reminderId);
    } catch {
      /* it will simply be re-offered on the next sync */
    }
    await get().sync();
  },

  async completeFromAlarm(reminderId) {
    clearAudio(reminderId);
    clearNotification(reminderId);
    void clearNativeFor(reminderId, get);
    set((state) => ({ ringing: state.ringing.filter((r) => r.reminder.id !== reminderId) }));

    const itemId = await resolveItemId(reminderId, get);
    if (itemId) {
      await useData.getState().toggleComplete(itemId, true);
      try {
        await api.dismissReminder(reminderId);
      } catch {
        /* non-fatal */
      }
    } else {
      // Nothing to complete means nothing to acknowledge either; leave the
      // reminder alone rather than silently swallowing it.
      useUi.getState().toast(useUi.getState().t('error.generic'), 'error');
    }
    await get().sync();
  },

  stopAllSound() {
    for (const id of [...handles.keys()]) clearAudio(id);
  },

  testRing(reminder) {
    ring(reminder, set, get, false);
  },
}));

function onVisibility() {
  if (document.visibilityState === 'visible') void useAlarms.getState().sync();
}

/**
 * Which task does this reminder belong to?
 *
 * Pressing "Done" on a lock-screen notification opens the app cold, so none of
 * the in-memory lists exist yet — reading only from `ringing` here meant the
 * one path the button exists for was the one path that did nothing. Look
 * through what is loaded, then go to the server, and only then give up.
 */
async function resolveItemId(reminderId: string, get: () => AlarmState): Promise<string | null> {
  const ringing = get().ringing.find((r) => r.reminder.id === reminderId);
  if (ringing) return ringing.reminder.itemId;

  const known = useData.getState().reminders.find((r) => r.id === reminderId);
  if (known) return known.itemId;

  try {
    const remote = await api.listReminders();
    return remote.find((r) => r.id === reminderId)?.itemId ?? null;
  } catch {
    return null;
  }
}

/** Carry out a button pressed on a system notification. */
async function runAlarmAction(action: string, reminderId: string) {
  const alarms = useAlarms.getState();
  if (action === 'snooze') await alarms.snooze(reminderId);
  else if (action === 'done') await alarms.completeFromAlarm(reminderId);
  else await alarms.dismiss(reminderId);
}

function onServiceWorkerMessage(event: MessageEvent) {
  const data = event.data as { type?: string; action?: string; reminderId?: string } | undefined;
  if (!data?.reminderId) return;

  if (data.type === 'alarm-action') {
    void runAlarmAction(data.action ?? 'open', data.reminderId);
  } else if (data.type === 'alarm-notification-closed') {
    // Swiping the notification away is an acknowledgement; stop the sound but
    // leave the reminder itself alone so a repeat still comes round again.
    clearAudio(data.reminderId);
    useAlarms.setState((state) => ({
      ringing: state.ringing.filter((r) => r.reminder.id !== data.reminderId),
    }));
  }
}

type SetState = (partial: Partial<AlarmState> | ((s: AlarmState) => Partial<AlarmState>)) => void;
type GetState = () => AlarmState;

/**
 * The words the OS shows on a notification.
 *
 * Read from the live dictionary each time rather than captured once: the OS
 * copy is written when the alarm is scheduled, and a person who switches the
 * app to Arabic should not keep getting English alarms for the next two days.
 */
function alarmStrings(): AlarmStrings {
  const ui = useUi.getState();
  return {
    alarmBody: ui.t('reminder.due'),
    stillWaiting: ui.t('reminder.stillWaiting'),
    snooze: ui.t('reminder.snooze'),
    done: ui.t('item.complete'),
    inMinutes: (n: number) => ui.t('common.minutes', { n }),
  };
}

/**
 * Take one alarm out of the OS's hands.
 *
 * Called whenever an alarm is acknowledged in the app. Without it, snoozing an
 * alarm on screen would leave the operating system's copy — and its queued
 * follow-ups — to go off anyway a moment later.
 */
async function clearNativeFor(reminderId: string, get: () => AlarmState) {
  if (!isNative()) return;
  const known =
    get().ringing.find((r) => r.reminder.id === reminderId)?.reminder ??
    get().armed.find((r) => r.id === reminderId);
  if (known) await cancelNativeAlarm(known);
}

/** Has this task been finished since the alarm list was last fetched? */
function isDone(itemId: string): boolean {
  return useData.getState().items.some((i) => i.id === itemId && i.status === 'done');
}

function tick(set: SetState, get: GetState) {
  const state = get();
  const now = Date.now() + state.serverOffsetMs;

  for (const reminder of state.armed) {
    if (!reminder.nextFireAt) continue;
    // The armed list is only as fresh as the last poll. Completing a task
    // seconds before its alarm should silence it immediately, not a minute
    // later, so check the task's live state rather than the arming snapshot.
    if (isDone(reminder.item.id)) continue;
    const fireAt = new Date(reminder.nextFireAt).getTime();

    // Pre-alerts: a quiet heads-up N minutes before the real alarm.
    for (const lead of reminder.leadMinutes) {
      const leadKey = `${reminder.id}:${reminder.nextFireAt}:${lead}`;
      const leadAt = fireAt - lead * 60_000;
      if (now >= leadAt && now < fireAt && !state.leadAlertsSent.includes(leadKey)) {
        set((s) => ({ leadAlertsSent: [...s.leadAlertsSent.slice(-50), leadKey] }));
        const ui = useUi.getState();
        ui.toast(`${reminder.item.icon || '⏰'} ${reminder.item.title} — ${ui.t('common.minutes', { n: lead })}`, 'info');
        showNotification(reminder, ui.t('common.minutes', { n: lead }), false);
      }
    }

    if (now >= fireAt && !state.ringing.some((r) => r.reminder.id === reminder.id)) {
      ring(reminder, set, get, false);
    }
  }
}

function ring(reminder: DueReminder, set: SetState, get: GetState, missed: boolean) {
  const ui = useUi.getState();

  set((state) => ({
    ringing: [...state.ringing, { reminder, startedAt: Date.now(), missed }],
    // Drop it from the armed list so the ticker cannot double-fire it.
    armed: state.armed.filter((r) => r.id !== reminder.id),
  }));

  /**
   * On a phone the operating system is already playing this alarm's sound
   * from its own scheduled notification. Playing it here as well would give
   * two copies a fraction of a second apart, which sounds broken and is
   * louder than either was meant to be — so the app takes the screen and the
   * OS takes the sound.
   *
   * A *missed* alarm is the exception: it is being replayed now because the
   * app was closed when it was due, so there is no OS sound to collide with.
   */
  const osIsRinging = isNative() && !missed;
  if (!osIsRinging) {
    const handle = playSound(reminder.soundId, {
      volume: reminder.volume,
      // Escalating alarms loop until dismissed; the rest stop by themselves.
      loop: true,
    });
    handles.set(reminder.id, handle);
  }

  if (reminder.vibrate && !osIsRinging) {
    vibrate([400, 200, 400]);
    vibrateTimers.set(
      reminder.id,
      window.setInterval(() => vibrate([400, 200, 400]), 2500),
    );
  }

  // Likewise the notification: the OS already posted one, and a web
  // Notification on top of it would be the same alarm shown twice.
  if (!osIsRinging) showNotification(reminder, reminder.label || ui.t('reminder.ringingNow'));

  if (!reminder.escalate) {
    autoStopTimers.set(
      reminder.id,
      window.setTimeout(() => {
        handles.get(reminder.id)?.stop();
        handles.delete(reminder.id);
        const vibrateTimer = vibrateTimers.get(reminder.id);
        if (vibrateTimer !== undefined) window.clearInterval(vibrateTimer);
        vibrateTimers.delete(reminder.id);
      }, reminder.ringSeconds * 1000),
    );
  }

  // Tell the server it went off so a repeating alarm advances to its next slot.
  void api.markReminderFired(reminder.id).catch(() => {
    /* it stays pending and will be re-offered — better than losing it */
  });
}
