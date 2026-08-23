import { assumedEffort, scoreItems } from './demo/engine';
import type { Item, Reminder } from './types';

/**
 * Turning "what matters" into "when you will do it".
 *
 * A ranked list still leaves the hardest part to the person holding it: a list
 * of nine things, in the right order, does not tell you whether they fit
 * before six o'clock, or which of them you are quietly not going to do. This
 * lays them into the actual hours available and says so plainly, including
 * what will not fit.
 *
 * The plan is a *proposal*, recomputed from scratch every time. Nothing is
 * stored, so it cannot go stale, disagree with the task list, or become
 * another thing to maintain.
 */

const MINUTE = 60_000;

export type BlockKind = 'fixed' | 'task' | 'break';

export interface PlanBlock {
  kind: BlockKind;
  start: string;
  end: string;
  minutes: number;
  itemId?: string;
  title: string;
  icon: string;
  color: string;
  /** Why it is here, and here specifically. */
  reason: PlanReason;
  /** How well this hour suits the task's energy demand, 0..1. */
  fit?: number;
}

export type PlanReason =
  | 'alarm'
  | 'overdue'
  | 'dueToday'
  | 'peakEnergy'
  | 'quickWin'
  | 'unblocks'
  | 'ranked'
  | 'breather';

export interface PlanLeftOver {
  itemId: string;
  title: string;
  icon: string;
  minutes: number;
  /** Why it did not make it in. */
  reason: 'noRoom' | 'blocked' | 'afterHours';
}

export interface DayPlan {
  /** The window the plan was laid into. */
  from: string;
  to: string;
  blocks: PlanBlock[];
  leftOver: PlanLeftOver[];
  /** Minutes of work placed, and minutes of window there were to place it in. */
  plannedMinutes: number;
  availableMinutes: number;
  /** Over-committed by this many minutes, or 0. */
  overBy: number;
  /** The hour-by-hour energy curve used, 0..1 for hours 0-23. */
  energyCurve: number[];
  /** How many completions the curve was learned from; 0 means the default. */
  learnedFrom: number;
}

export interface PlanOptions {
  workStartHour?: number;
  workEndHour?: number;
  capacityMinutes?: number;
  /** A pause after a stretch of work, so a plan is not a wall of back-to-back. */
  breakMinutes?: number;
  breakAfterMinutes?: number;
  /** Ignore the learned curve; useful for testing and for a first-run default. */
  useLearnedEnergy?: boolean;
}

/**
 * When people actually get things done.
 *
 * Learned from completion times rather than assumed, because the assumption is
 * usually wrong: "mornings are for deep work" is a fine default and a poor
 * description of somebody who does their real thinking at eleven at night.
 * Below a handful of completions there is nothing to learn from and the
 * default curve is used unchanged — inventing a peak from two data points
 * would be worse than admitting we do not know yet.
 */
const MIN_COMPLETIONS_TO_LEARN = 12;

/** A conventional day: sharp mid-morning, a dip after lunch, a second wind. */
const DEFAULT_CURVE = [
  0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.35, 0.55, 0.75, 0.95, 1.0, 0.9,
  0.65, 0.5, 0.6, 0.75, 0.8, 0.7, 0.6, 0.5, 0.45, 0.35, 0.2, 0.12,
];

export function learnEnergyCurve(items: Item[], now = new Date()): { curve: number[]; from: number } {
  const horizon = now.getTime() - 90 * 24 * 60 * MINUTE;
  const hours = new Array(24).fill(0);
  let total = 0;

  for (const item of items) {
    if (!item.completedAt) continue;
    const at = new Date(item.completedAt);
    const time = at.getTime();
    if (!Number.isFinite(time) || time < horizon) continue;
    // Weight by effort: finishing a two-hour task at 10am says more about when
    // you can concentrate than ticking off a one-minute errand.
    const weight = Math.min(4, 1 + assumedEffort(item) / 60);
    hours[at.getHours()] += weight;
    total += weight;
  }

  const completions = items.filter((i) => i.completedAt && new Date(i.completedAt).getTime() >= horizon).length;
  if (completions < MIN_COMPLETIONS_TO_LEARN || total === 0) {
    return { curve: [...DEFAULT_CURVE], from: 0 };
  }

  // Smooth across neighbouring hours: nobody's concentration changes at the
  // stroke of the hour, and a single busy Tuesday should not carve a spike.
  const smoothed = hours.map((_, hour) => {
    const before = hours[(hour + 23) % 24];
    const after = hours[(hour + 1) % 24];
    return hours[hour] * 0.6 + before * 0.2 + after * 0.2;
  });
  const peak = Math.max(...smoothed);
  if (peak === 0) return { curve: [...DEFAULT_CURVE], from: 0 };

  // Blended with the default rather than replacing it, so a person with three
  // months of evenings still gets a sane shape for the hours they have no
  // history in at all.
  const curve = smoothed.map((value, hour) => {
    const learned = value / peak;
    const confidence = Math.min(1, completions / (MIN_COMPLETIONS_TO_LEARN * 4));
    return Math.max(0.05, learned * confidence + DEFAULT_CURVE[hour] * (1 - confidence));
  });
  return { curve, from: completions };
}

/** How well an hour suits a task, given how much energy the task demands. */
function fitFor(energy: number, curveValue: number): number {
  // Energy runs 1 (trivial) to 5 (demanding). A demanding task in a low hour
  // is a bad match; an easy one is nearly indifferent to the hour, which is
  // what makes easy tasks the right thing to put in the dip after lunch.
  const demand = Math.max(0, Math.min(1, (energy - 1) / 4));
  return 1 - demand * (1 - curveValue);
}

interface Interval {
  start: number;
  end: number;
}

function subtract(free: Interval[], busy: Interval): Interval[] {
  const out: Interval[] = [];
  for (const slot of free) {
    if (busy.end <= slot.start || busy.start >= slot.end) {
      out.push(slot);
      continue;
    }
    if (busy.start > slot.start) out.push({ start: slot.start, end: busy.start });
    if (busy.end < slot.end) out.push({ start: busy.end, end: slot.end });
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Lay today's work into today's hours.
 *
 * Alarms come first and cannot move — they are appointments, not preferences.
 * Everything else is fitted around them, best task into best remaining hour,
 * with hard rules kept hard: nothing is scheduled before it may start, after
 * it is due, or before whatever it depends on.
 */
export function planDay(
  items: Item[],
  reminders: Reminder[],
  options: PlanOptions = {},
  now = new Date(),
): DayPlan {
  const workStart = options.workStartHour ?? 9;
  const workEnd = options.workEndHour ?? 19;
  const capacity = options.capacityMinutes ?? 240;
  const breakMinutes = options.breakMinutes ?? 10;
  const breakAfter = options.breakAfterMinutes ?? 90;

  const live = items.filter((i) => !i.deletedAt && i.status !== 'done');
  const byId = new Map(items.map((i) => [i.id, i]));

  const dayStart = new Date(now);
  dayStart.setHours(workStart, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setHours(workEnd, 0, 0, 0);

  // The plan starts now, not this morning: a plan that opens with hours you
  // have already lived is not a plan.
  const from = Math.max(now.getTime(), dayStart.getTime());
  const to = dayEnd.getTime();

  const { curve, from: learnedFrom } = learnEnergyCurve(items, now);

  const blocks: PlanBlock[] = [];
  const leftOver: PlanLeftOver[] = [];

  if (to <= from) {
    return {
      from: iso(from),
      to: iso(Math.max(from, to)),
      blocks,
      leftOver: live
        .filter((i) => i.dueAt && new Date(i.dueAt).getTime() <= to)
        .map((item) => ({
          itemId: item.id,
          title: item.title,
          icon: item.icon,
          minutes: assumedEffort(item),
          reason: 'afterHours' as const,
        })),
      plannedMinutes: 0,
      availableMinutes: 0,
      overBy: 0,
      energyCurve: curve,
      learnedFrom,
    };
  }

  // ── 1. Alarms are appointments ──────────────────────────────────────────
  const fixedIds = new Set<string>();
  let free: Interval[] = [{ start: from, end: to }];

  const todaysAlarms = reminders
    .filter((reminder) => {
      if (reminder.status === 'done' || !reminder.nextFireAt) return false;
      const at = new Date(reminder.nextFireAt).getTime();
      return at >= from && at < to;
    })
    .sort((a, b) => (a.nextFireAt ?? '').localeCompare(b.nextFireAt ?? ''));

  for (const reminder of todaysAlarms) {
    const item = byId.get(reminder.itemId);
    if (!item || item.deletedAt || item.status === 'done') continue;
    const start = new Date(reminder.nextFireAt as string).getTime();
    const minutes = Math.max(10, assumedEffort(item));
    const end = Math.min(to, start + minutes * MINUTE);
    blocks.push({
      kind: 'fixed',
      start: iso(start),
      end: iso(end),
      minutes: Math.round((end - start) / MINUTE),
      itemId: item.id,
      title: reminder.label || item.title,
      icon: item.icon,
      color: item.color,
      reason: 'alarm',
    });
    free = subtract(free, { start, end });
    fixedIds.add(item.id);
  }

  // ── 2. Everything else, best first ──────────────────────────────────────
  const scored = scoreItems(live, now.getTime());
  const candidates = scored.filter((s) => {
    if (fixedIds.has(s.item.id)) return false;
    // A category with children is a heading, not a thing you sit down and do.
    const hasChildren = live.some((i) => i.parentId === s.item.id);
    return !hasChildren;
  });

  for (const s of candidates) {
    if (!s.blocked) continue;
    leftOver.push({
      itemId: s.item.id,
      title: s.item.title,
      icon: s.item.icon,
      minutes: assumedEffort(s.item),
      reason: 'blocked',
    });
  }

  const placeable = candidates.filter((s) => !s.blocked);
  const scheduled = new Set<string>();
  let plannedMinutes = 0;

  /** Can this task legitimately start here, and for how long? */
  const fitAt = (s: (typeof placeable)[number], start: number, slotEnd: number): number | null => {
    const item = s.item;
    if (item.startAt && new Date(item.startAt).getTime() > start) return null;
    const blockers = (item.blockedBy ?? []).filter((id) => {
      const blocker = byId.get(id);
      return blocker && blocker.status !== 'done' && !blocker.deletedAt;
    });
    if (blockers.length) return null;

    const wanted = Math.max(10, assumedEffort(item));
    const room = Math.round((slotEnd - start) / MINUTE);
    if (room < 10) return null;
    const minutes = Math.min(wanted, room);
    const finish = start + minutes * MINUTE;

    if (item.dueAt) {
      const due = new Date(item.dueAt).getTime();
      // Overdue work should happen now; anything else must finish in time.
      if (due >= now.getTime() && due < finish) return null;
    }
    return minutes;
  };

  const reserve = (start: number, end: number) => {
    free = subtract(free, { start, end });
  };

  const push = (
    s: (typeof placeable)[number],
    start: number,
    minutes: number,
    reason: PlanReason,
  ) => {
    const hour = new Date(start).getHours();
    blocks.push({
      kind: 'task',
      start: iso(start),
      end: iso(start + minutes * MINUTE),
      minutes,
      itemId: s.item.id,
      title: s.item.title,
      icon: s.item.icon,
      color: s.item.color,
      reason,
      fit: Number(fitFor(s.item.energy ?? 3, curve[hour] ?? 0.5).toFixed(2)),
    });
    scheduled.add(s.item.id);
    plannedMinutes += minutes;
    reserve(start, start + minutes * MINUTE);
  };

  const reasonFor = (s: (typeof placeable)[number], minutes: number, fit: number): PlanReason => {
    const due = s.item.dueAt ? new Date(s.item.dueAt).getTime() : null;
    if (due !== null && due < now.getTime()) return 'overdue';
    if (due !== null && due <= to) return 'dueToday';
    if (s.blockingCount > 0) return 'unblocks';
    if (fit > 0.8 && (s.item.energy ?? 3) >= 4) return 'peakEnergy';
    if (minutes <= 15) return 'quickWin';
    return 'ranked';
  };

  /**
   * Demanding work gets first refusal on the good hours.
   *
   * Filling the day earliest-first is simpler, and it wastes the peak: the
   * first task to come along takes the best hour whether or not it needs one,
   * and the hard thinking ends up wherever is left. So anything genuinely
   * demanding chooses its hour across the whole day first, and everything else
   * fills in around it. The step is fifteen minutes because a plan pinned to
   * the minute is a plan nobody can follow.
   */
  const STEP = 15 * MINUTE;
  const demanding = placeable
    .filter((s) => (s.item.energy ?? 3) >= 4 && !scheduled.has(s.item.id))
    .sort((a, b) => b.score - a.score);

  for (const s of demanding) {
    if (plannedMinutes >= capacity) break;
    let best: { start: number; minutes: number; value: number } | null = null;

    for (const slot of free) {
      // Align to the step so blocks land on readable times.
      const first = Math.ceil(slot.start / STEP) * STEP;
      for (let start = Math.max(first, slot.start); start < slot.end; start += STEP) {
        const minutes = fitAt(s, start, slot.end);
        if (minutes === null) continue;
        const hour = new Date(start).getHours();
        const fit = fitFor(s.item.energy ?? 3, curve[hour] ?? 0.5);
        // Earlier wins ties, so a flat curve still produces a sensible day.
        const value = fit - (start - from) / (1000 * MINUTE * 1000);
        if (!best || value > best.value) best = { start, minutes, value };
      }
    }

    if (!best) continue;
    const hour = new Date(best.start).getHours();
    push(s, best.start, best.minutes, reasonFor(s, best.minutes, fitFor(s.item.energy ?? 3, curve[hour] ?? 0.5)));
  }

  // Everything else fills the gaps that are left, earliest first.
  let sinceBreak = 0;
  let guard = 0;
  while (plannedMinutes < capacity && guard++ < 200) {
    let placed = false;
    for (const slot of [...free].sort((a, b) => a.start - b.start)) {
      const start = slot.start;
      const hour = new Date(start).getHours();
      const curveValue = curve[hour] ?? 0.5;

      let best: { s: (typeof placeable)[number]; minutes: number; value: number } | null = null;
      for (const s of placeable) {
        if (scheduled.has(s.item.id)) continue;
        const minutes = fitAt(s, start, slot.end);
        if (minutes === null) continue;
        const fit = fitFor(s.item.energy ?? 3, curveValue);
        let value = s.score * (0.55 + 0.45 * fit);
        const due = s.item.dueAt ? new Date(s.item.dueAt).getTime() : null;
        if (due !== null && due < now.getTime()) value *= 1.5;
        else if (due !== null && due <= to) value *= 1.25;
        else if (s.blockingCount > 0) value *= 1.15;
        // A task that has to be cut short to fit is a worse use of the gap.
        if (minutes < Math.max(10, assumedEffort(s.item))) value *= 0.7;
        if (!best || value > best.value) best = { s, minutes, value };
      }

      if (!best) continue;
      const fit = fitFor(best.s.item.energy ?? 3, curveValue);
      push(best.s, start, best.minutes, reasonFor(best.s, best.minutes, fit));
      sinceBreak += best.minutes;
      placed = true;

      // A breather, once a stretch has run long enough to need one.
      const after = start + best.minutes * MINUTE;
      if (sinceBreak >= breakAfter && after + breakMinutes * MINUTE < slot.end) {
        blocks.push({
          kind: 'break',
          start: iso(after),
          end: iso(after + breakMinutes * MINUTE),
          minutes: breakMinutes,
          title: '',
          icon: '',
          color: '',
          reason: 'breather',
        });
        reserve(after, after + breakMinutes * MINUTE);
        sinceBreak = 0;
      }
      break;
    }
    if (!placed) break;
  }

  for (const s of placeable) {
    if (scheduled.has(s.item.id)) continue;
    // Only complain about things that actually wanted today.
    const wantsToday = s.item.dueAt && new Date(s.item.dueAt).getTime() <= to;
    if (!wantsToday) continue;
    leftOver.push({
      itemId: s.item.id,
      title: s.item.title,
      icon: s.item.icon,
      minutes: assumedEffort(s.item),
      reason: 'noRoom',
    });
  }

  blocks.sort((a, b) => a.start.localeCompare(b.start));

  const availableMinutes = Math.round((to - from) / MINUTE);
  const wanted = plannedMinutes + leftOver.reduce((sum, l) => sum + l.minutes, 0);

  return {
    from: iso(from),
    to: iso(to),
    blocks,
    leftOver,
    plannedMinutes,
    availableMinutes,
    overBy: Math.max(0, wanted - Math.min(capacity, availableMinutes)),
    energyCurve: curve,
    learnedFrom,
  };
}
