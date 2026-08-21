import type { DueReminder } from '../types';

/**
 * Notification ids.
 *
 * Kept apart from the scheduler because this is the part that decides whether
 * an alarm can be found again — and losing an id means an alarm that cannot be
 * cancelled, which is worse than one that never rang. Nothing here touches a
 * platform, so it can be tested without a phone.
 *
 * Local notifications are addressed by integer, while reminders have string
 * ids and repeating ones have many occurrences. The hash therefore covers the
 * occurrence as well: without that, tomorrow's alarm would overwrite today's
 * and one of the two would quietly never happen.
 */

/** How long a closed-app alarm keeps trying, in seconds after the first ring. */
export const ESCALATION_STEPS = [30, 60, 120, 180, 300];

/**
 * Stable 31-bit id from a string.
 *
 * FNV-1a: short, no dependencies, and well enough spread that two live
 * reminders colliding is not a practical concern. Kept positive and inside the
 * signed-int range because Android rejects anything else.
 */
export function idFor(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 2_000_000_000) + 1;
}

export const mainId = (reminderId: string, occurrence: string) =>
  idFor(`${reminderId}|${occurrence}|main`);
export const leadId = (reminderId: string, occurrence: string, minutes: number) =>
  idFor(`${reminderId}|${occurrence}|lead${minutes}`);
export const escalationId = (reminderId: string, occurrence: string, seconds: number) =>
  idFor(`${reminderId}|${occurrence}|esc${seconds}`);

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
