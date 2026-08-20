import { similarity } from '../text';
import type { DayLoad, Insight, Item, Recurrence, ScoredItem, StreakReport } from '../types';
import type { DemoActivity } from './store';

/**
 * The reasoning and scheduling the server normally does, re-implemented over
 * plain arrays for the static demo.
 *
 * It mirrors `server/src/lib/recurrence.ts` and `server/src/lib/reasoning.ts`
 * — same weights, same thresholds, same explanations — but reads from memory
 * instead of SQL, and works in the browser's own timezone rather than the
 * account's stored one (in a browser they are the same thing).
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const startOfDay = (date: Date): Date => {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
};

const dateKey = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

// ── Recurrence ─────────────────────────────────────────────────────────────

function monthDayMatches(wanted: number[], year: number, month: number, day: number): boolean {
  const last = daysInMonth(year, month);
  for (const w of wanted) {
    if (w === -1) {
      if (day === last) return true;
    } else if (w === day) {
      return true;
    } else if (w > last && day === last) {
      // "the 31st" in a 30-day month clamps to the last day rather than skipping.
      return true;
    }
  }
  return false;
}

function dayMatches(rule: Recurrence, interval: number, anchor: Date, probe: Date): boolean {
  const anchorDay = startOfDay(anchor).getTime();
  const probeDay = startOfDay(probe).getTime();
  if (probeDay < anchorDay) return false;

  switch (rule.freq) {
    case 'daily':
      return Math.round((probeDay - anchorDay) / DAY) % interval === 0;
    case 'weekly': {
      const weekdays = rule.byWeekday?.length ? rule.byWeekday : [anchor.getDay()];
      if (!weekdays.includes(probe.getDay())) return false;
      const weeks = Math.floor(probeDay / (7 * DAY)) - Math.floor(anchorDay / (7 * DAY));
      return weeks % interval === 0;
    }
    case 'monthly': {
      const months =
        (probe.getFullYear() - anchor.getFullYear()) * 12 + (probe.getMonth() - anchor.getMonth());
      if (months < 0 || months % interval !== 0) return false;
      return monthDayMatches(rule.byMonthDay ?? [anchor.getDate()], probe.getFullYear(), probe.getMonth() + 1, probe.getDate());
    }
    case 'yearly': {
      const years = probe.getFullYear() - anchor.getFullYear();
      if (years < 0 || years % interval !== 0) return false;
      const months = rule.byMonth?.length ? rule.byMonth : [anchor.getMonth() + 1];
      if (!months.includes(probe.getMonth() + 1)) return false;
      return monthDayMatches(rule.byMonthDay ?? [anchor.getDate()], probe.getFullYear(), probe.getMonth() + 1, probe.getDate());
    }
    default:
      return false;
  }
}

/** Next occurrence strictly after `after`. `anchor` fixes the phase and time of day. */
export function nextOccurrence(
  rule: Recurrence,
  anchor: Date,
  after: Date,
  occurrencesSoFar = 0,
): Date | null {
  if (rule.count !== undefined && occurrencesSoFar >= rule.count) return null;
  const until = rule.until ? new Date(rule.until).getTime() : Infinity;
  if (Number.isNaN(until)) return null;

  const interval = Math.max(1, rule.interval || 1);
  const from = Math.max(after.getTime(), anchor.getTime() - 1);

  // Fixed-length frequencies are arithmetic — no calendar walking needed.
  if (rule.freq === 'minutely' || rule.freq === 'hourly') {
    const step = (rule.freq === 'minutely' ? MINUTE : HOUR) * interval;
    const elapsed = from - anchor.getTime();
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / step) + 1;
    const next = anchor.getTime() + steps * step;
    return next <= until ? new Date(next) : null;
  }

  const times = rule.at?.length
    ? [...rule.at].sort((a, b) => a.hour - b.hour || a.minute - b.minute)
    : [{ hour: anchor.getHours(), minute: anchor.getMinutes() }];

  const exceptions = new Set(rule.exceptions ?? []);
  const cursor = startOfDay(new Date(Math.max(from, anchor.getTime())));

  for (let i = 0; i < 2000; i++) {
    if (dayMatches(rule, interval, anchor, cursor)) {
      for (const time of times) {
        const candidate = new Date(cursor);
        candidate.setHours(time.hour, time.minute, 0, 0);
        const ms = candidate.getTime();
        if (ms <= from) continue;
        if (ms > until) return null;
        if (exceptions.has(dateKey(candidate))) break;
        return candidate;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

/**
 * When does this reminder ring next? An active snooze wins, then a first
 * occurrence still ahead, then the repeat rolled past now. A one-shot whose
 * time passed unacknowledged stays pending so it still rings — a missed alarm
 * that silently disappears is the worst failure this app could have.
 */
export function computeNextFire(
  reminder: { fireAt: string; rrule: Recurrence | null; status: string; snoozedUntil: string | null; lastFiredAt: string | null },
  now = new Date(),
): string | null {
  if (reminder.status === 'done') return null;
  if (reminder.snoozedUntil && new Date(reminder.snoozedUntil) > now) return reminder.snoozedUntil;

  const first = new Date(reminder.fireAt);
  if (!reminder.rrule) {
    if (reminder.status === 'dismissed') return null;
    return reminder.lastFiredAt ? null : reminder.fireAt;
  }
  if (first > now) return reminder.fireAt;
  const next = nextOccurrence(reminder.rrule, first, now);
  return next ? next.toISOString() : null;
}

// ── Scoring ────────────────────────────────────────────────────────────────

const PRIORITY_WEIGHT = [0, 25, 50, 78, 100];

export function assumedEffort(item: Item): number {
  if (item.effortMinutes > 0) return item.effortMinutes;
  return [10, 20, 30, 60, 90][Math.min(4, Math.max(0, item.energy - 1))];
}

function urgencyFor(item: Item, now: number): { value: number; reason?: string } {
  if (!item.dueAt) return { value: 12 };
  const due = new Date(item.dueAt).getTime();
  if (Number.isNaN(due)) return { value: 12 };
  const hours = (due - now) / HOUR;

  if (hours <= 0) {
    const overdueDays = Math.min(30, -hours / 24);
    // Overdue stays near the top, but grows slowly so a month-old item cannot
    // bury everything merely due today.
    return { value: Math.min(100, 88 + overdueDays * 0.4), reason: 'overdue' };
  }
  if (hours <= 2) return { value: 86, reason: 'due_within_2h' };
  if (hours <= 12) return { value: 74, reason: 'due_today' };
  if (hours <= 36) return { value: 58, reason: 'due_tomorrow' };
  return { value: Math.max(8, 58 * Math.exp(-(hours - 36) / 190)) };
}

export function scoreItems(allItems: Item[], now = Date.now()): ScoredItem[] {
  const live = allItems.filter((i) => !i.deletedAt);
  const byId = new Map(live.map((i) => [i.id, i]));

  const childCount = new Map<string, number>();
  for (const i of live) {
    if (i.parentId) childCount.set(i.parentId, (childCount.get(i.parentId) ?? 0) + 1);
  }

  const blocking = new Map<string, number>();
  for (const i of live) {
    for (const dep of i.blockedBy) blocking.set(dep, (blocking.get(dep) ?? 0) + 1);
  }

  const scored: ScoredItem[] = [];
  for (const item of live) {
    if (item.status !== 'open') continue;
    // A node with children is a container; its children carry the real work.
    if ((childCount.get(item.id) ?? 0) > 0) continue;

    const reasons: ScoredItem['reasons'] = [];
    const { value: urgency, reason } = urgencyFor(item, now);
    if (reason) reasons.push({ code: reason, weight: urgency });

    const importance = PRIORITY_WEIGHT[Math.min(4, Math.max(0, item.priority))];
    if (item.priority >= 3) reasons.push({ code: 'high_priority', weight: importance });

    const effort = assumedEffort(item);
    const quickWin = effort <= 15 ? 100 : effort <= 30 ? 70 : effort <= 60 ? 40 : 15;
    if (effort <= 15) reasons.push({ code: 'quick_win', weight: quickWin, detail: `${effort}m` });

    const ageDays = (now - new Date(item.createdAt).getTime()) / DAY;
    const staleness = Math.min(100, Math.max(0, (ageDays - 3) * 4));
    if (ageDays > 14) reasons.push({ code: 'stale', weight: staleness, detail: `${Math.round(ageDays)}d` });

    const openBlockers = item.blockedBy.filter((id) => byId.get(id)?.status === 'open');
    const blocked = openBlockers.length > 0;
    if (blocked) reasons.push({ code: 'blocked', weight: -100, detail: String(openBlockers.length) });

    const blocks = blocking.get(item.id) ?? 0;
    if (blocks > 0) reasons.push({ code: 'blocks_others', weight: blocks * 8, detail: String(blocks) });
    if (item.pinned) reasons.push({ code: 'pinned', weight: 15 });

    let score = 0.42 * urgency + 0.34 * importance + 0.12 * quickWin + 0.12 * staleness + blocks * 4;
    if (item.pinned) score += 15;
    // Blocked work is not actionable, so it sinks rather than disappearing.
    if (blocked) score = score * 0.15;

    scored.push({
      item,
      score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
      urgency: Math.round(urgency),
      importance,
      reasons,
      blocked,
      blockingCount: blocks,
    });
  }

  return scored.sort((a, b) => b.score - a.score);
}

export function workloadForecast(
  allItems: Item[],
  capacity = 240,
  days = 14,
  now = new Date(),
): DayLoad[] {
  const buckets = new Map<string, DayLoad>();
  for (let d = 0; d < days; d++) {
    const key = dateKey(new Date(now.getTime() + d * DAY));
    buckets.set(key, { date: key, minutes: 0, count: 0, overdue: 0, capacity, overloaded: false });
  }

  const todayKey = dateKey(now);
  for (const item of allItems) {
    if (item.deletedAt || item.status !== 'open' || !item.dueAt) continue;
    const due = new Date(item.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    // Anything already overdue is work that has to happen today.
    const key = due < now ? todayKey : dateKey(due);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.minutes += assumedEffort(item);
    bucket.count += 1;
    if (due < now) bucket.overdue += 1;
  }

  return [...buckets.values()].map((b) => ({ ...b, overloaded: b.minutes > b.capacity }));
}

export function dependencyReport(allItems: Item[]) {
  const live = allItems.filter((i) => !i.deletedAt);
  const deps = new Map(live.map((i) => [i.id, i.blockedBy.filter((d) => d !== i.id)]));
  const status = new Map(live.map((i) => [i.id, i.status]));

  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string) => {
    const seen = state.get(id) ?? 0;
    if (seen === 1) {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    if (seen === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const next of deps.get(id) ?? []) if (deps.has(next)) visit(next);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of deps.keys()) visit(id);

  const readyNow = [...deps.entries()]
    .filter(([id, list]) => status.get(id) === 'open' && list.every((d) => status.get(d) !== 'open'))
    .map(([id]) => id);

  const inCycle = new Set(cycles.flat());
  const memo = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    if (inCycle.has(id)) return [id];
    const cached = memo.get(id);
    if (cached) return cached;
    memo.set(id, [id]); // guard against re-entry
    let best = [id];
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next) || status.get(next) !== 'open') continue;
      const sub = chain(next);
      if (sub.length + 1 > best.length) best = [id, ...sub];
    }
    memo.set(id, best);
    return best;
  };

  let longestChain: string[] = [];
  for (const id of deps.keys()) {
    if (status.get(id) !== 'open') continue;
    const c = chain(id);
    if (c.length > longestChain.length) longestChain = c;
  }

  return { cycles, readyNow, longestChain };
}

export function findDuplicates(allItems: Item[], threshold = 0.55) {
  const open = allItems
    .filter((i) => !i.deletedAt && i.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const groups: Array<{ ids: string[]; titles: string[]; similarity: number }> = [];
  const claimed = new Set<string>();

  for (let i = 0; i < open.length; i++) {
    const a = open[i];
    if (claimed.has(a.id)) continue;
    const matches: Item[] = [];
    let best = 0;
    for (let j = i + 1; j < open.length; j++) {
      const b = open[j];
      if (claimed.has(b.id)) continue;
      const score = similarity(a.title, b.title);
      if (score >= threshold) {
        matches.push(b);
        best = Math.max(best, score);
      }
    }
    if (matches.length) {
      claimed.add(a.id);
      for (const m of matches) claimed.add(m.id);
      groups.push({
        ids: [a.id, ...matches.map((m) => m.id)],
        titles: [a.title, ...matches.map((m) => m.title)],
        similarity: Math.round(best * 100) / 100,
      });
    }
  }
  return groups;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'my', 'in', 'on', 'at', 'is', 'it',
  'في', 'من', 'على', 'الى', 'إلى', 'ال', 'и', 'в', 'на', 'для', 'с', 'по',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Suggest where a new item belongs, learned only from the user's own tree:
 * each category is a bag of words from its descendants, weighted by inverse
 * document frequency so distinctive words ("tyres") beat common ones ("buy").
 */
export function suggestCategories(allItems: Item[], title: string, limit = 3) {
  const live = allItems.filter((i) => !i.deletedAt);
  const byId = new Map(live.map((i) => [i.id, i]));
  const children = new Map<string, string[]>();
  for (const i of live) {
    if (!i.parentId) continue;
    children.set(i.parentId, [...(children.get(i.parentId) ?? []), i.id]);
  }

  const categories = live.filter((i) => (children.get(i.id) ?? []).length > 0);
  if (!categories.length) return [];

  const bagFor = (id: string): string[] => {
    const out = [...tokenize(byId.get(id)!.title)];
    const queue = [...(children.get(id) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      const node = byId.get(next);
      if (!node) continue;
      out.push(...tokenize(node.title));
      queue.push(...(children.get(next) ?? []));
    }
    return out;
  };

  const bags = new Map(categories.map((c) => [c.id, bagFor(c.id)]));
  const docFreq = new Map<string, number>();
  for (const bag of bags.values()) {
    for (const term of new Set(bag)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  const queryTerms = tokenize(title);
  const results = [];

  for (const category of categories) {
    const counts = new Map<string, number>();
    for (const term of bags.get(category.id)!) counts.set(term, (counts.get(term) ?? 0) + 1);

    let score = 0;
    const matchedTerms: string[] = [];
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      score += (1 + Math.log(tf)) * Math.log(1 + categories.length / (docFreq.get(term) ?? 1));
      matchedTerms.push(term);
    }
    score += similarity(title, category.title) * 2.2;
    if (score > 0.35) {
      results.push({
        id: category.id,
        title: category.title,
        confidence: Math.round(Math.min(1, score / 4) * 100) / 100,
        matchedTerms,
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

export function streaks(activity: DemoActivity[], now = new Date()): StreakReport {
  const perDay = new Map<string, number>();
  for (const entry of activity) {
    if (entry.kind !== 'item.completed' && entry.kind !== 'item.recurred') continue;
    const key = dateKey(new Date(entry.createdAt));
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  const todayKey = dateKey(now);
  let current = 0;
  for (let d = 0; d < 400; d++) {
    const key = dateKey(new Date(now.getTime() - d * DAY));
    if (perDay.has(key)) current++;
    // Today not being done yet must not break a streak that is still alive.
    else if (d > 0 || key !== todayKey) break;
  }

  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const key of [...perDay.keys()].sort()) {
    const ms = Date.parse(`${key}T00:00:00`);
    run = previous !== null && ms - previous === DAY ? run + 1 : 1;
    previous = ms;
    longest = Math.max(longest, run);
  }

  const last30 = Array.from({ length: 30 }, (_, i) => {
    const key = dateKey(new Date(now.getTime() - (29 - i) * DAY));
    return { date: key, count: perDay.get(key) ?? 0 };
  });

  return { current, longest, completedToday: perDay.get(todayKey) ?? 0, last30 };
}

export function buildInsights(
  allItems: Item[],
  activity: DemoActivity[],
  capacity: number,
  now = new Date(),
): Insight[] {
  const insights: Insight[] = [];
  const scored = scoreItems(allItems, now.getTime());

  const overdue = scored.filter((s) => s.item.dueAt && new Date(s.item.dueAt) < now);
  if (overdue.length) {
    insights.push({
      code: 'overdue',
      severity: overdue.length > 4 ? 'urgent' : 'warn',
      values: { count: overdue.length },
      itemIds: overdue.slice(0, 8).map((s) => s.item.id),
    });
  }

  const load = workloadForecast(allItems, capacity, 7, now);
  const overloaded = load.filter((d) => d.overloaded);
  const heaviest = [...load].sort((a, b) => b.minutes - a.minutes)[0];
  if (overloaded.length) {
    insights.push({
      code: 'overloaded_days',
      severity: 'warn',
      values: {
        count: overloaded.length,
        date: overloaded[0].date,
        hours: Math.round((overloaded[0].minutes / 60) * 10) / 10,
      },
    });
  } else if (heaviest && heaviest.minutes > 0) {
    insights.push({
      code: 'heaviest_day',
      severity: 'info',
      values: { date: heaviest.date, hours: Math.round((heaviest.minutes / 60) * 10) / 10 },
    });
  }

  const blocked = scored.filter((s) => s.blocked);
  if (blocked.length) {
    insights.push({
      code: 'blocked_items',
      severity: 'info',
      values: { count: blocked.length },
      itemIds: blocked.slice(0, 8).map((s) => s.item.id),
    });
  }

  const deps = dependencyReport(allItems);
  if (deps.cycles.length) {
    insights.push({
      code: 'dependency_cycle',
      severity: 'warn',
      values: { count: deps.cycles.length },
      itemIds: deps.cycles[0],
    });
  }

  const dupes = findDuplicates(allItems);
  if (dupes.length) {
    insights.push({
      code: 'possible_duplicates',
      severity: 'info',
      values: { count: dupes.length, example: dupes[0].titles.slice(0, 2).join(' / ') },
      itemIds: dupes[0].ids,
    });
  }

  const undated = scored.filter((s) => !s.item.dueAt);
  if (undated.length > 6) {
    insights.push({
      code: 'undated_backlog',
      severity: 'info',
      values: { count: undated.length },
      itemIds: undated.slice(0, 8).map((s) => s.item.id),
    });
  }

  const streak = streaks(activity, now);
  if (streak.current >= 2) {
    insights.push({ code: 'streak', severity: 'info', values: { days: streak.current } });
  }

  const quickWins = scored.filter((s) => !s.blocked && assumedEffort(s.item) <= 15);
  if (quickWins.length >= 3) {
    insights.push({
      code: 'quick_wins',
      severity: 'info',
      values: {
        count: quickWins.length,
        minutes: quickWins.slice(0, 5).reduce((n, s) => n + assumedEffort(s.item), 0),
      },
      itemIds: quickWins.slice(0, 5).map((s) => s.item.id),
    });
  }

  return insights;
}

export function suggestSlots(
  allItems: Item[],
  effortMinutes: number,
  options: { workStartHour?: number; workEndHour?: number; days?: number; capacity?: number } = {},
  now = new Date(),
) {
  const workStart = options.workStartHour ?? 9;
  const workEnd = options.workEndHour ?? 19;
  const capacity = options.capacity ?? 240;
  const load = workloadForecast(allItems, capacity, options.days ?? 7, now);

  const slots = [];
  for (const day of load) {
    const free = Math.max(0, day.capacity - day.minutes);
    if (free < effortMinutes) continue;
    // Start after the busiest part of the morning on loaded days, early otherwise.
    const startHour = Math.min(workEnd - Math.ceil(effortMinutes / 60), workStart + Math.floor(day.minutes / 60));
    if (startHour < workStart) continue;
    const start = new Date(`${day.date}T${String(startHour).padStart(2, '0')}:00:00`);
    if (Number.isNaN(start.getTime())) continue;
    const startMs = Math.max(start.getTime(), now.getTime() + 15 * MINUTE);
    slots.push({
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + effortMinutes * MINUTE).toISOString(),
      dayLoadMinutes: day.minutes,
      rank: Math.round((free / day.capacity) * 100),
    });
  }
  return slots.sort((a, b) => b.rank - a.rank).slice(0, 5);
}
