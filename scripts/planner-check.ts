/**
 * The day plan, checked against the rules it must never break.
 *
 * A planner that produces a pretty timetable which quietly schedules work
 * after its deadline, before its dependencies, or on top of an alarm is worse
 * than no planner: it looks authoritative and is wrong. These are the
 * invariants, not the aesthetics.
 */
import { learnEnergyCurve, planDay } from '../web/src/lib/planner';
import type { Item, Reminder } from '../web/src/lib/types';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? ' ok  ' : 'FAIL '} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

/** A fixed "today" so the plan is the same every run. */
const TODAY = new Date('2026-09-15T08:00:00.000Z'); // a Tuesday
const at = (hour: number, minute = 0) => {
  const d = new Date(TODAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

let seq = 0;
function item(over: Partial<Item> = {}): Item {
  seq++;
  return {
    id: `i${seq}`, parentId: null, title: `Task ${seq}`, notes: '', icon: '', color: '',
    status: 'open', priority: 3, energy: 3, effortMinutes: 30, dueAt: null, startAt: null,
    recurrence: null, tags: [], blockedBy: [], meta: {}, position: seq, pinned: false,
    displayMode: 'text', inkDrawingId: null,
    createdAt: at(0), updatedAt: at(0), completedAt: null, deletedAt: null,
    ...over,
  };
}

function reminder(itemId: string, fireAt: string): Reminder {
  return {
    id: `r-${itemId}`, itemId, label: '', fireAt, nextFireAt: fireAt, rrule: null,
    soundId: 'builtin:chime', volume: 0.9, vibrate: true, leadMinutes: [], snoozeMinutes: 9,
    snoozedUntil: null, escalate: false, ringSeconds: 60, status: 'scheduled',
    lastFiredAt: null, createdAt: at(0), updatedAt: at(0),
  };
}

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  a.start < b.end && b.start < a.end;

console.log('planning the day\n');

// ── the basics ────────────────────────────────────────────────────────────
const simple = [item({ title: 'Write the report', effortMinutes: 60, energy: 5 }),
                item({ title: 'Email the invoice', effortMinutes: 10, energy: 1 }),
                item({ title: 'Tidy the desk', effortMinutes: 20, energy: 2 })];
let plan = planDay(simple, [], { workStartHour: 9, workEndHour: 17, capacityMinutes: 480 }, TODAY);

check('a plan is produced', plan.blocks.length > 0, `${plan.blocks.length} blocks`);
check('nothing starts before the working day',
  plan.blocks.every((b) => b.start >= plan.from), plan.from);
check('nothing runs past the end of it',
  plan.blocks.every((b) => b.end <= plan.to), plan.to);
check('no two blocks overlap',
  plan.blocks.every((a, i) => plan.blocks.slice(i + 1).every((b) => !overlaps(a, b))));
check('nothing is scheduled twice', (() => {
  const ids = plan.blocks.filter((b) => b.itemId).map((b) => b.itemId!);
  return new Set(ids).size === ids.length;
})());
check('every block says why it is there',
  plan.blocks.every((b) => Boolean(b.reason)));

// ── alarms are appointments ───────────────────────────────────────────────
const withAlarm = [item({ title: 'Call the dentist', effortMinutes: 15 }),
                   item({ title: 'Deep work', effortMinutes: 120, energy: 5 })];
const alarmPlan = planDay(withAlarm, [reminder(withAlarm[0].id, at(11, 30))],
  { workStartHour: 9, workEndHour: 17, capacityMinutes: 480 }, TODAY);
const fixed = alarmPlan.blocks.find((b) => b.kind === 'fixed');
check('an alarm becomes a fixed appointment', Boolean(fixed), fixed?.start);
check('it is at the time the alarm fires', fixed?.start === at(11, 30), `${fixed?.start} vs ${at(11, 30)}`);
check('work is scheduled around it, never over it',
  alarmPlan.blocks.filter((b) => b.kind !== 'fixed').every((b) => !fixed || !overlaps(b, fixed)));

// ── the hard rules ────────────────────────────────────────────────────────
const deadline = [item({ title: 'Due at noon', effortMinutes: 60, dueAt: at(12), priority: 5 }),
                  item({ title: 'Whenever', effortMinutes: 60 })];
const deadlinePlan = planDay(deadline, [], { workStartHour: 9, workEndHour: 17, capacityMinutes: 480 }, TODAY);
const dueBlock = deadlinePlan.blocks.find((b) => b.itemId === deadline[0].id);
check('a task with a deadline finishes before it',
  !dueBlock || dueBlock.end <= at(12), `${dueBlock?.end} vs ${at(12)}`);

const blocked = [item({ title: 'First', effortMinutes: 30 })];
const second = item({ title: 'Second', effortMinutes: 30, blockedBy: [blocked[0].id], priority: 5 });
const blockedPlan = planDay([...blocked, second], [], { workStartHour: 9, workEndHour: 17 }, TODAY);
check('a blocked task is not scheduled at all',
  !blockedPlan.blocks.some((b) => b.itemId === second.id));
check('and is reported as blocked, not silently dropped',
  blockedPlan.leftOver.some((l) => l.itemId === second.id && l.reason === 'blocked'));

const notYet = item({ title: 'Not before 3pm', effortMinutes: 30, startAt: at(15) });
const startPlan = planDay([notYet], [], { workStartHour: 9, workEndHour: 17 }, TODAY);
const startBlock = startPlan.blocks.find((b) => b.itemId === notYet.id);
check('nothing is scheduled before it may start',
  !startBlock || startBlock.start >= at(15), startBlock?.start);

// ── a category is a heading, not a task ───────────────────────────────────
const parent = item({ title: 'Cars', effortMinutes: 0 });
const child = item({ title: 'Oil change', parentId: parent.id, effortMinutes: 30 });
const treePlan = planDay([parent, child], [], { workStartHour: 9, workEndHour: 17 }, TODAY);
check('a category with things inside it is not scheduled',
  !treePlan.blocks.some((b) => b.itemId === parent.id));
check('but the thing inside it is',
  treePlan.blocks.some((b) => b.itemId === child.id));

// ── honesty about capacity ────────────────────────────────────────────────
const tooMuch = Array.from({ length: 14 }, () =>
  item({ effortMinutes: 60, dueAt: at(17), priority: 4 }));
const packed = planDay(tooMuch, [], { workStartHour: 9, workEndHour: 17, capacityMinutes: 300 }, TODAY);
check('it stops at the capacity you set',
  packed.plannedMinutes <= 300, `${packed.plannedMinutes} of 300 minutes`);
check('and says what will not fit',
  packed.leftOver.some((l) => l.reason === 'noRoom'), `${packed.leftOver.length} left over`);
check('and by how much you are over',
  packed.overBy > 0, `${packed.overBy} minutes over`);

// ── late in the day ───────────────────────────────────────────────────────
const evening = new Date(TODAY);
evening.setHours(23, 30, 0, 0);
const late = planDay(simple, [], { workStartHour: 9, workEndHour: 17 }, evening);
check('after hours it plans nothing rather than inventing time',
  late.blocks.length === 0 && late.availableMinutes === 0);

// ── learning when you work ────────────────────────────────────────────────
const noHistory = learnEnergyCurve([item()], TODAY);
check('with no history it uses a sensible default', noHistory.from === 0 && noHistory.curve.length === 24);

const nightOwl: Item[] = [];
for (let d = 1; d <= 30; d++) {
  const day = new Date(TODAY);
  day.setDate(day.getDate() - d);
  day.setHours(22, 0, 0, 0);
  nightOwl.push(item({ status: 'done', completedAt: day.toISOString(), effortMinutes: 90 }));
}
const learned = learnEnergyCurve(nightOwl, TODAY);
check('with enough history it learns from it', learned.from >= 12, `${learned.from} completions`);
check('a night owl gets a late peak, not a morning one',
  learned.curve[22] > learned.curve[9], `22:00 ${learned.curve[22].toFixed(2)} vs 09:00 ${learned.curve[9].toFixed(2)}`);
check('the curve stays in range', learned.curve.every((v) => v >= 0 && v <= 1));

// A demanding task should land in a good hour when there is a choice.
const demanding = item({ title: 'Hard thinking', effortMinutes: 60, energy: 5 });
const easy = item({ title: 'Filing', effortMinutes: 60, energy: 1 });
const energyPlan = planDay([demanding, easy, ...nightOwl], [],
  { workStartHour: 9, workEndHour: 23, capacityMinutes: 480 }, TODAY);
const hardBlock = energyPlan.blocks.find((b) => b.itemId === demanding.id);
const easyBlock = energyPlan.blocks.find((b) => b.itemId === easy.id);
// Compare the *hours*, not the fit scores: fit is normalised per energy level,
// so an undemanding task reads 1.0 in every hour by construction and the two
// numbers are not on the same scale.
const hourOf = (block?: { start: string }) => (block ? new Date(block.start).getHours() : -1);
const hardHour = hourOf(hardBlock);
const easyHour = hourOf(easyBlock);
check('the demanding task gets the better hour of the two',
  Boolean(hardBlock && easyBlock) && energyPlan.energyCurve[hardHour] >= energyPlan.energyCurve[easyHour],
  `hard at ${hardHour}:00 (${energyPlan.energyCurve[hardHour]?.toFixed(2)}) vs easy at ${easyHour}:00 (${energyPlan.energyCurve[easyHour]?.toFixed(2)})`);
check('and the easy one absorbs the weaker hour',
  easyHour >= 0 && hardHour >= 0 && easyHour !== hardHour,
  `${easyHour}:00 vs ${hardHour}:00`);

// ── determinism ───────────────────────────────────────────────────────────
const a = JSON.stringify(planDay(simple, [], { workStartHour: 9, workEndHour: 17 }, TODAY));
const b = JSON.stringify(planDay(simple, [], { workStartHour: 9, workEndHour: 17 }, TODAY));
check('the same day plans the same way twice', a === b);

console.log(failed ? `\n${failed} check(s) failed` : '\nthe plan holds together');
process.exit(failed ? 1 : 0);
