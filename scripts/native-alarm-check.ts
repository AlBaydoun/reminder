/**
 * The notification ids handed to the phone's OS, checked without a phone.
 *
 * These are the properties that decide whether an alarm rings and whether it
 * can be silenced again. An earlier version of this hashed the reminder id and
 * occurrence into a 31-bit integer; this test is what caught that colliding
 * about a quarter of the time at a few tens of thousands of ids — two alarms
 * sharing an id means one silently replaces the other and never goes off.
 */
import {
  ESCALATION_STEPS,
  existingId,
  idsForOccurrence,
  mainId,
  flushIds,
  pruneIds,
  trackedIdCount,
  useIdStorage,
  type IdStorage,
} from '../web/src/lib/native/alarmIds';
import type { DueReminder } from '../web/src/lib/types';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? ' ok  ' : 'FAIL '} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

/** A stand-in for localStorage, so a run can be restarted mid-test. */
function memoryStorage(): IdStorage & { dump(): string | null } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    dump: () => map.get('nexus.alarmIds') ?? null,
  };
}

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

console.log('native alarm ids\n');

let store = memoryStorage();
useIdStorage(store);

// Stable, or an alarm cannot be cancelled once it has been scheduled.
const r = reminder({ nextFireAt: at(60) });
const first = idsForOccurrence(r, r.nextFireAt!);
const again = idsForOccurrence(r, r.nextFireAt!);
check('ids are stable across calls', JSON.stringify(first) === JSON.stringify(again), `${first[0]}`);

// A repeating reminder's occurrences must differ, or tomorrow overwrites today.
check(
  'each occurrence gets its own ids',
  mainId(r.id, at(60)) !== mainId(r.id, at(60 + 24 * 60)),
  `${mainId(r.id, at(60))} vs ${mainId(r.id, at(60 + 24 * 60))}`,
);
check(
  'different reminders get different ids',
  mainId('r1', r.nextFireAt!) !== mainId('r2', r.nextFireAt!),
);

// The whole point of allocating instead of hashing.
const seen = new Map<number, string>();
let collisions = 0;
for (let i = 0; i < 4000; i++) {
  const rem = reminder({ id: `reminder-${i}`, leadMinutes: [5, 30], escalate: true });
  const occurrence = at(60 + i);
  for (const id of idsForOccurrence(rem, occurrence)) {
    const owner = `reminder-${i}|${occurrence}`;
    const previous = seen.get(id);
    if (previous && previous !== owner) collisions++;
    seen.set(id, owner);
  }
}
check(
  'no collisions across 4000 reminders',
  collisions === 0,
  `${seen.size} ids issued, ${collisions} collisions`,
);

// Android's notification id is a Java int.
const wide = [
  ...idsForOccurrence(reminder({ id: 'a'.repeat(500), leadMinutes: [5, 60, 1440], escalate: true }), at(90)),
  ...idsForOccurrence(reminder({ id: '☃️ الاختبار «r»' }), at(5)),
  ...first,
  ...seen.keys(),
];
check(
  'every id is a positive 32-bit integer',
  wide.every((id) => Number.isInteger(id) && id > 0 && id < 2 ** 31),
  `${wide.length} ids checked`,
);

// Cancelling has to cover the alarm, its pre-alerts and its repeats.
const full = reminder({ id: 'full', leadMinutes: [10, 60], escalate: true, nextFireAt: at(120) });
const ids = idsForOccurrence(full, full.nextFireAt!);
check('cancelling covers alarm, pre-alerts and repeats', ids.length === 1 + 2 + ESCALATION_STEPS.length, `${ids.length} ids`);
check('no duplicate ids within one occurrence', new Set(ids).size === ids.length);

// Cancel must read, never allocate: minting a new id would cancel nothing and
// leave the real alarm to ring after it had been dismissed.
const before = trackedIdCount();
check(
  'a never-scheduled alarm has no id to cancel',
  existingId('never-scheduled', at(60), 'main') === undefined,
);
check('and looking does not allocate one', trackedIdCount() === before, `${before} tracked`);
check(
  'a scheduled alarm can be found again',
  existingId(full.id, full.nextFireAt!, 'main') === ids[0],
);

// Ids survive a restart, because they are what cancellation depends on.
flushIds();
const saved = store.dump();
const restarted = memoryStorage();
if (saved) restarted.setItem('nexus.alarmIds', saved);
useIdStorage(restarted);
check(
  'ids survive the app being restarted',
  existingId(full.id, full.nextFireAt!, 'main') === ids[0],
  `${ids[0]}`,
);

// The map must not grow for the life of the install.
const beforePrune = trackedIdCount();
const removed = pruneIds(Date.now() + 5000 * 60_000);
check(
  'past occurrences are forgotten',
  removed > 0 && trackedIdCount() < beforePrune,
  `${beforePrune} → ${trackedIdCount()} (${removed} pruned)`,
);
// Pruning must not touch an alarm that has not happened yet.
const future = reminder({ id: 'future', nextFireAt: at(60) });
const futureId = mainId(future.id, future.nextFireAt!);
pruneIds();
check('but future alarms are kept', existingId(future.id, future.nextFireAt!, 'main') === futureId);

console.log(failed ? `\n${failed} check(s) failed` : '\nthe ids hold');
process.exit(failed ? 1 : 0);
