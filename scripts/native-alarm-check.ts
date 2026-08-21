/**
 * The native alarm plan, checked without a phone.
 *
 * What the OS is asked to hold is pure logic — given a set of reminders and a
 * clock, which notifications should exist, at what times, with which ids. That
 * part can be tested here; only the handing-over is device-specific. These are
 * the properties that decide whether an alarm rings, so they are worth
 * pinning down rather than discovering on a handset.
 */
import { idsForOccurrence } from '../web/src/lib/native/alarmIds';
import type { DueReminder } from '../web/src/lib/types';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? ' ok  ' : 'FAIL '} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function reminder(over: Partial<DueReminder> = {}): DueReminder {
  return {
    id: 'r1', itemId: 'i1', label: '', fireAt: at(60), nextFireAt: at(60),
    rrule: null, soundId: 'builtin:chime', volume: 0.9, vibrate: true,
    leadMinutes: [], snoozeMinutes: 9, snoozedUntil: null, escalate: false,
    ringSeconds: 60, status: 'scheduled', lastFiredAt: null,
    createdAt: at(-1000), updatedAt: at(-1000),
    item: { id: 'i1', title: 'Take the bins out', icon: '🗑️', color: '#7C6BFF', status: 'open' },
    ...over,
  };
}

console.log('native alarm plan\n');

// Ids must be stable: the app has to be able to find an alarm again to cancel it.
const r = reminder();
const first = idsForOccurrence(r, r.nextFireAt!);
const again = idsForOccurrence(r, r.nextFireAt!);
check('ids are stable across calls', JSON.stringify(first) === JSON.stringify(again), `${first[0]}`);

// A repeating reminder's occurrences must not share ids, or tomorrow's alarm
// overwrites today's and one of the two silently never rings.
const today = idsForOccurrence(r, at(60));
const tomorrow = idsForOccurrence(r, at(60 + 24 * 60));
check('each occurrence gets its own ids', today[0] !== tomorrow[0], `${today[0]} vs ${tomorrow[0]}`);

// Two different reminders must not collide either.
const other = idsForOccurrence(reminder({ id: 'r2' }), r.nextFireAt!);
check('different reminders get different ids', first[0] !== other[0], `${first[0]} vs ${other[0]}`);

// Android rejects negative ids and ids outside the int range.
const wide = [
  ...idsForOccurrence(reminder({ id: 'a'.repeat(200), leadMinutes: [5, 60, 1440], escalate: true }), at(90)),
  ...idsForOccurrence(reminder({ id: '☃️ الاختبар', escalate: true }), at(5)),
  ...first,
];
check(
  'every id is a positive 32-bit integer',
  wide.every((id) => Number.isInteger(id) && id > 0 && id < 2 ** 31),
  `${wide.length} ids checked`,
);

// The cancel path has to cover the alarm, its pre-alerts and its repeats —
// missing one leaves a snoozed alarm going off anyway a moment later.
const full = reminder({ leadMinutes: [10, 60], escalate: true });
const ids = idsForOccurrence(full, full.nextFireAt!);
check('cancelling covers alarm, pre-alerts and repeats', ids.length === 1 + 2 + 5, `${ids.length} ids`);
check('no duplicate ids within one occurrence', new Set(ids).size === ids.length);

// A wide sweep for collisions, since a collision means a lost alarm.
const seen = new Map<number, string>();
let collisions = 0;
for (let i = 0; i < 4000; i++) {
  const rem = reminder({ id: `reminder-${i}`, leadMinutes: [5, 30], escalate: true });
  const occurrence = at(60 + i);
  for (const id of idsForOccurrence(rem, occurrence)) {
    const key = `reminder-${i}|${occurrence}`;
    const previous = seen.get(id);
    if (previous && previous !== key) collisions++;
    seen.set(id, key);
  }
}
check('no collisions across 4000 reminders', collisions === 0, `${seen.size} distinct ids, ${collisions} collisions`);

console.log(failed ? `\n${failed} check(s) failed` : '\nthe alarm plan holds');
process.exit(failed ? 1 : 0);
