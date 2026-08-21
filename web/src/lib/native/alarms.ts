import type { DueReminder } from '../types';
import {
  ESCALATION_STEPS,
  escalationId,
  existingId,
  flushIds,
  leadId,
  mainId,
  pruneIds,
} from './alarmIds';
import { isAndroid, isNative, loadLocalNotifications } from './bridge';
import { channelIdFor, ensureChannel, nativeSoundFor } from './sounds';

/**
 * Handing alarms to the operating system.
 *
 * The web app rings by running a ticker in an open tab, which is the best a
 * browser allows and is exactly the limitation the phone build exists to
 * remove. Here the OS is told, ahead of time, when to make a noise — so the
 * alarm goes off with the app closed, the screen locked and the phone in
 * a pocket, and it survives a reboot.
 *
 * Two things about local notifications shape everything below.
 *
 * They need integer ids, while reminders have string ones. Ids are therefore
 * hashed, and because a *repeating* reminder has many occurrences, the hash
 * covers the occurrence too — otherwise tomorrow's alarm would overwrite
 * today's.
 *
 * And a notification sound plays once. An alarm that goes "ding" and gives up
 * is not an alarm, so an escalating reminder schedules a short run of
 * follow-ups behind the first one. Acknowledging the alarm cancels the rest,
 * which is why every id is derived rather than random: they have to be
 * findable again to be cancelled.
 */

interface PlannedNotification {
  id: number;
  title: string;
  body: string;
  at: Date;
  reminder: DueReminder;
  occurrence: string;
  /** Pre-alerts are informational; they must not sound like the alarm itself. */
  kind: 'main' | 'lead' | 'escalation';
}

/** What the OS should be holding for one reminder. */
function planFor(reminder: DueReminder, now: number, dict: AlarmStrings): PlannedNotification[] {
  const occurrence = reminder.nextFireAt;
  if (!occurrence) return [];
  const fireAt = new Date(occurrence).getTime();
  if (!Number.isFinite(fireAt)) return [];

  const title = `${reminder.item.icon || '⏰'} ${reminder.item.title}`.trim();
  const label = reminder.label || dict.alarmBody;
  const plan: PlannedNotification[] = [];

  if (fireAt > now) {
    plan.push({
      id: mainId(reminder.id, occurrence),
      title,
      body: label,
      at: new Date(fireAt),
      reminder,
      occurrence,
      kind: 'main',
    });

    for (const lead of reminder.leadMinutes) {
      const leadAt = fireAt - lead * 60_000;
      if (leadAt <= now) continue;
      plan.push({
        id: leadId(reminder.id, occurrence, lead),
        title,
        body: dict.inMinutes(lead),
        at: new Date(leadAt),
        reminder,
        occurrence,
        kind: 'lead',
      });
    }

    if (reminder.escalate) {
      for (const step of ESCALATION_STEPS) {
        plan.push({
          id: escalationId(reminder.id, occurrence, step),
          title,
          body: dict.stillWaiting,
          at: new Date(fireAt + step * 1000),
          reminder,
          occurrence,
          kind: 'escalation',
        });
      }
    }
  }

  return plan;
}

export interface AlarmStrings {
  alarmBody: string;
  stillWaiting: string;
  snooze: string;
  done: string;
  inMinutes(n: number): string;
}

const ACTION_TYPE = 'NEXUS_ALARM';
let actionsRegistered = false;

/** The Snooze / Done buttons, registered once. */
async function registerActions(dict: AlarmStrings) {
  if (actionsRegistered) return;
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications) return;
  await LocalNotifications.registerActionTypes({
    types: [
      {
        id: ACTION_TYPE,
        actions: [
          { id: 'snooze', title: dict.snooze },
          { id: 'done', title: dict.done, destructive: false },
        ],
      },
    ],
  });
  actionsRegistered = true;
}

/**
 * Make the OS's picture of the future match ours.
 *
 * Reconciled rather than rewritten: cancelling and re-scheduling every alarm
 * on each poll would mean a thirty-second window, repeated forever, in which
 * an alarm about to fire briefly does not exist.
 */
export async function syncNativeAlarms(
  reminders: DueReminder[],
  dict: AlarmStrings,
  now = Date.now(),
): Promise<{ scheduled: number; cancelled: number } | null> {
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications) return null;

  await registerActions(dict);

  const wanted = new Map<number, PlannedNotification>();
  for (const reminder of reminders) {
    // A finished task's alarm has no business waking anyone.
    if (reminder.item.status === 'done') continue;
    for (const planned of planFor(reminder, now, dict)) wanted.set(planned.id, planned);
  }

  const pending = await LocalNotifications.getPending();
  const have = new Set(pending.notifications.map((n) => n.id));

  const stale = [...have].filter((id) => !wanted.has(id));
  if (stale.length) {
    await LocalNotifications.cancel({ notifications: stale.map((id) => ({ id })) });
  }

  const toSchedule = [...wanted.values()].filter((n) => !have.has(n.id));
  if (toSchedule.length) {
    const notifications = await Promise.all(toSchedule.map((n) => toNative(n)));
    await LocalNotifications.schedule({ notifications });
  }

  // The registry only needs the alarms still ahead of us. Both of these write
  // it out, so the ids are on disk before the app can be killed — losing them
  // would mean losing the ability to cancel the alarms just scheduled.
  pruneIds(now);
  flushIds();

  return { scheduled: toSchedule.length, cancelled: stale.length };
}

async function toNative(planned: PlannedNotification) {
  const { reminder, kind } = planned;
  const sound = await nativeSoundFor(reminder.soundId);

  // Android binds a sound to a channel, so each distinct sound needs its own.
  let channelId: string | undefined;
  if (isAndroid()) {
    channelId = channelIdFor(reminder.soundId, kind === 'lead');
    await ensureChannel(channelId, sound, kind === 'lead', reminder.vibrate);
  }

  return {
    id: planned.id,
    title: planned.title,
    body: planned.body,
    schedule: {
      at: planned.at,
      // Fire at the stated second even in doze; this is the whole point.
      allowWhileIdle: true,
    },
    sound,
    channelId,
    // A pre-alert is a heads-up, not a summons: no buttons, no full screen.
    actionTypeId: kind === 'lead' ? undefined : ACTION_TYPE,
    extra: {
      reminderId: reminder.id,
      itemId: reminder.itemId,
      occurrence: planned.occurrence,
      kind,
    },
    smallIcon: 'ic_stat_nexus',
    iconColor: reminder.item.color || '#7C6BFF',
    ongoing: false,
    autoCancel: true,
  };
}

/**
 * Silence one alarm everywhere: the notification showing now and every
 * follow-up still queued behind it.
 */
export async function cancelNativeAlarm(reminder: DueReminder, occurrence?: string | null) {
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications) return;
  const at = occurrence ?? reminder.nextFireAt;
  if (!at) return;

  // Only ids that were actually handed out. Asking the registry to *allocate*
  // here would mint fresh numbers and cancel nothing, leaving the real alarm
  // to go off after it had been dismissed.
  const slots = [
    'main' as const,
    ...reminder.leadMinutes.map((lead) => `lead${lead}` as const),
    ...ESCALATION_STEPS.map((step) => `esc${step}` as const),
  ];
  const ids = slots
    .map((slot) => existingId(reminder.id, at, slot))
    .filter((id): id is number => id !== undefined)
    .map((id) => ({ id }));
  if (!ids.length) return;
  await LocalNotifications.cancel({ notifications: ids });
  // A delivered notification is not "pending", so it needs removing too.
  try {
    const delivered = await LocalNotifications.getDeliveredNotifications();
    const mine = delivered.notifications.filter((n) => ids.some((i) => i.id === n.id));
    if (mine.length) await LocalNotifications.removeDeliveredNotifications({ notifications: mine });
  } catch {
    /* not every platform implements this; the cancel above is the important half */
  }
}

/** Drop every alarm this app has scheduled. Used on sign-out. */
export async function clearAllNativeAlarms() {
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications) return;
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel(pending);
}

/**
 * Permission, and the separate right to be exact.
 *
 * Android 12 introduced a switch for exact alarms that the user can turn off,
 * and an inexact alarm may land fifteen minutes late — useless here. When it
 * is missing the app says so rather than quietly becoming approximate.
 */
export async function nativeAlarmPermissions(): Promise<{
  notifications: boolean;
  exact: boolean;
  supported: boolean;
}> {
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications) return { notifications: false, exact: false, supported: false };

  const status = await LocalNotifications.checkPermissions();
  let notifications = status.display === 'granted';
  if (!notifications && status.display === 'prompt') {
    const asked = await LocalNotifications.requestPermissions();
    notifications = asked.display === 'granted';
  }

  let exact = true;
  if (isAndroid()) {
    try {
      const result = await LocalNotifications.checkExactNotificationSetting();
      exact = result.exact_alarm === 'granted';
    } catch {
      // Older Android has no such setting, which means exact alarms are simply
      // allowed — the absence of the API is a "yes", not a "no".
      exact = true;
    }
  }
  return { notifications, exact, supported: true };
}

/** Open the OS screen where exact alarms are switched back on. */
export async function openExactAlarmSettings(): Promise<boolean> {
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications || !isAndroid()) return false;
  try {
    await LocalNotifications.changeExactNotificationSetting();
    return true;
  } catch {
    return false;
  }
}

export const nativeAlarmsAvailable = () => isNative();
