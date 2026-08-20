import { db, parseJson } from '../db.js';
import { DAY, HOUR, zonedDateKey } from './time.js';
import { serializeItem, type Item, type ItemRow } from './items.js';

/**
 * The reasoning layer. Everything here is deterministic and explainable —
 * each score carries the reasons that produced it, so the UI can say *why*
 * something is at the top of the list instead of asking for blind trust.
 */

export interface ScoredItem {
  item: Item;
  score: number;
  urgency: number;
  importance: number;
  reasons: Array<{ code: string; weight: number; detail?: string }>;
  blocked: boolean;
  blockingCount: number;
}

const PRIORITY_WEIGHT = [0, 25, 50, 78, 100];

/** Minutes we assume a task costs when the user has not estimated it. */
function assumedEffort(item: Item): number {
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
    // Overdue work stays pinned to the top, growing slowly so a month-old
    // task cannot bury everything that is merely due today.
    return { value: Math.min(100, 88 + overdueDays * 0.4), reason: 'overdue' };
  }
  if (hours <= 2) return { value: 86, reason: 'due_within_2h' };
  if (hours <= 12) return { value: 74, reason: 'due_today' };
  if (hours <= 36) return { value: 58, reason: 'due_tomorrow' };
  // Smooth exponential decay after that — a due date two weeks out barely moves the needle.
  return { value: Math.max(8, 58 * Math.exp(-(hours - 36) / 190)) };
}

export function scoreItems(userId: string, now = Date.now()): ScoredItem[] {
  const rows = db
    .prepare(`SELECT * FROM items WHERE user_id = ? AND deleted_at IS NULL`)
    .all(userId) as ItemRow[];
  const items = rows.map(serializeItem);
  const byId = new Map(items.map((i) => [i.id, i]));

  const childCount = new Map<string, number>();
  for (const i of items) {
    if (i.parentId) childCount.set(i.parentId, (childCount.get(i.parentId) ?? 0) + 1);
  }

  // How many other items each item is holding up — a blocker deserves priority.
  const blocking = new Map<string, number>();
  for (const i of items) {
    for (const dep of i.blockedBy) blocking.set(dep, (blocking.get(dep) ?? 0) + 1);
  }

  const scored: ScoredItem[] = [];
  for (const item of items) {
    if (item.status !== 'open') continue;
    // A node with children is a container; its children carry the real work.
    if ((childCount.get(item.id) ?? 0) > 0) continue;

    const reasons: ScoredItem['reasons'] = [];
    const { value: urgency, reason: urgencyReason } = urgencyFor(item, now);
    if (urgencyReason) reasons.push({ code: urgencyReason, weight: urgency });

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

    let score =
      0.42 * urgency + 0.34 * importance + 0.12 * quickWin + 0.12 * staleness + blocks * 4;
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

export interface DayLoad {
  date: string;
  minutes: number;
  count: number;
  overdue: number;
  capacity: number;
  overloaded: boolean;
}

/** Effort landing on each of the next `days` days, against a daily capacity. */
export function workloadForecast(
  userId: string,
  timeZone: string,
  dailyCapacityMinutes = 240,
  days = 14,
  now = new Date(),
): DayLoad[] {
  const rows = db
    .prepare(
      `SELECT * FROM items WHERE user_id = ? AND deleted_at IS NULL AND status = 'open' AND due_at IS NOT NULL`,
    )
    .all(userId) as ItemRow[];
  const items = rows.map(serializeItem);

  const buckets = new Map<string, DayLoad>();
  for (let d = 0; d < days; d++) {
    const key = zonedDateKey(new Date(now.getTime() + d * DAY), timeZone);
    buckets.set(key, {
      date: key,
      minutes: 0,
      count: 0,
      overdue: 0,
      capacity: dailyCapacityMinutes,
      overloaded: false,
    });
  }

  const todayKey = zonedDateKey(now, timeZone);
  for (const item of items) {
    const due = new Date(item.dueAt!);
    if (Number.isNaN(due.getTime())) continue;
    // Anything already overdue is work that has to happen today.
    const key = due < now ? todayKey : zonedDateKey(due, timeZone);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.minutes += assumedEffort(item);
    bucket.count += 1;
    if (due < now) bucket.overdue += 1;
  }

  return [...buckets.values()].map((b) => ({ ...b, overloaded: b.minutes > b.capacity }));
}

export interface DependencyReport {
  cycles: string[][];
  readyNow: string[];
  longestChain: string[];
}

/** Cycle detection + topological readiness over the blockedBy graph. */
export function dependencyReport(userId: string): DependencyReport {
  const rows = db
    .prepare(`SELECT id, blocked_by, status FROM items WHERE user_id = ? AND deleted_at IS NULL`)
    .all(userId) as Array<{ id: string; blocked_by: string; status: string }>;

  const deps = new Map<string, string[]>();
  const status = new Map<string, string>();
  for (const r of rows) {
    deps.set(r.id, parseJson<string[]>(r.blocked_by, []).filter((d) => d !== r.id));
    status.set(r.id, r.status);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on stack, 2 done
  const stack: string[] = [];

  const visit = (id: string) => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push(stack.slice(start).concat(id));
      return;
    }
    if (s === 2) return;
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

  // Longest chain of still-open dependencies — the project's critical path.
  const depth = new Map<string, { len: number; path: string[] }>();
  const inCycle = new Set(cycles.flat());
  const chain = (id: string): { len: number; path: string[] } => {
    if (inCycle.has(id)) return { len: 1, path: [id] };
    const cached = depth.get(id);
    if (cached) return cached;
    depth.set(id, { len: 1, path: [id] }); // guard against re-entry
    let best = { len: 1, path: [id] };
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next) || status.get(next) !== 'open') continue;
      const sub = chain(next);
      if (sub.len + 1 > best.len) best = { len: sub.len + 1, path: [id, ...sub.path] };
    }
    depth.set(id, best);
    return best;
  };

  let longest: string[] = [];
  for (const id of deps.keys()) {
    if (status.get(id) !== 'open') continue;
    const c = chain(id);
    if (c.len > longest.length) longest = c.path;
  }

  return { cycles, readyNow, longestChain: longest };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'my', 'in', 'on', 'at', 'is', 'it',
  'في', 'من', 'على', 'الى', 'إلى', 'ال',
  'и', 'в', 'на', 'для', 'с', 'по',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function trigrams(text: string): Set<string> {
  const s = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < Math.max(1, s.length - 2); i++) out.add(s.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export interface DuplicateGroup {
  ids: string[];
  titles: string[];
  similarity: number;
}

/** Near-duplicate open items, e.g. "buy milk" vs "Buy some milk". */
export function findDuplicates(userId: string, threshold = 0.55): DuplicateGroup[] {
  const rows = db
    .prepare(
      `SELECT id, title, parent_id FROM items
       WHERE user_id = ? AND deleted_at IS NULL AND status = 'open' ORDER BY created_at ASC LIMIT 1500`,
    )
    .all(userId) as Array<{ id: string; title: string; parent_id: string | null }>;

  const groups: DuplicateGroup[] = [];
  const claimed = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (claimed.has(a.id)) continue;
    const matches: typeof rows = [];
    let best = 0;
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (claimed.has(b.id)) continue;
      const sim = similarity(a.title, b.title);
      if (sim >= threshold) {
        matches.push(b);
        best = Math.max(best, sim);
      }
    }
    if (matches.length) {
      for (const m of matches) claimed.add(m.id);
      claimed.add(a.id);
      groups.push({
        ids: [a.id, ...matches.map((m) => m.id)],
        titles: [a.title, ...matches.map((m) => m.title)],
        similarity: Math.round(best * 100) / 100,
      });
    }
  }
  return groups;
}

export interface CategorySuggestion {
  id: string;
  title: string;
  confidence: number;
  matchedTerms: string[];
}

/**
 * Suggest where a new item belongs, learned purely from the user's own tree:
 * each category is a bag of words drawn from its descendants, scored against
 * the new title with inverse-document-frequency weighting so distinctive
 * words ("tyres") count far more than common ones ("buy").
 */
export function suggestCategories(userId: string, title: string, limit = 3): CategorySuggestion[] {
  const rows = db
    .prepare(`SELECT id, parent_id, title FROM items WHERE user_id = ? AND deleted_at IS NULL`)
    .all(userId) as Array<{ id: string; parent_id: string | null; title: string }>;

  const children = new Map<string, string[]>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (!r.parent_id) continue;
    children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r.id]);
  }

  const categories = rows.filter((r) => (children.get(r.id) ?? []).length > 0);
  if (!categories.length) return [];

  const bagFor = (id: string): string[] => {
    const out: string[] = [...tokenize(byId.get(id)!.title)];
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
  const results: CategorySuggestion[] = [];

  for (const category of categories) {
    const bag = bags.get(category.id)!;
    const counts = new Map<string, number>();
    for (const t of bag) counts.set(t, (counts.get(t) ?? 0) + 1);

    let score = 0;
    const matched: string[] = [];
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      const idf = Math.log(1 + categories.length / (docFreq.get(term) ?? 1));
      score += (1 + Math.log(tf)) * idf;
      matched.push(term);
    }
    // A title that reads like the category name itself is a strong signal.
    score += similarity(title, category.title) * 2.2;
    if (score > 0.35) {
      results.push({
        id: category.id,
        title: category.title,
        confidence: Math.round(Math.min(1, score / 4) * 100) / 100,
        matchedTerms: matched,
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

export interface StreakReport {
  current: number;
  longest: number;
  completedToday: number;
  last30: Array<{ date: string; count: number }>;
}

export function streaks(userId: string, timeZone: string, now = new Date()): StreakReport {
  const rows = db
    .prepare(
      `SELECT created_at FROM activity
       WHERE user_id = ? AND kind IN ('item.completed', 'item.recurred') AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(userId, new Date(now.getTime() - 400 * DAY).toISOString()) as Array<{ created_at: string }>;

  const perDay = new Map<string, number>();
  for (const r of rows) {
    const key = zonedDateKey(new Date(r.created_at), timeZone);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  const todayKey = zonedDateKey(now, timeZone);
  let current = 0;
  for (let d = 0; d < 400; d++) {
    const key = zonedDateKey(new Date(now.getTime() - d * DAY), timeZone);
    if (perDay.has(key)) current++;
    // Today not being done yet must not break a streak that is still alive.
    else if (d > 0 || key !== todayKey) break;
  }

  const sortedDays = [...perDay.keys()].sort();
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const key of sortedDays) {
    const ms = Date.parse(`${key}T00:00:00Z`);
    run = prev !== null && ms - prev === DAY ? run + 1 : 1;
    prev = ms;
    longest = Math.max(longest, run);
  }

  const last30 = Array.from({ length: 30 }, (_, i) => {
    const key = zonedDateKey(new Date(now.getTime() - (29 - i) * DAY), timeZone);
    return { date: key, count: perDay.get(key) ?? 0 };
  });

  return { current, longest, completedToday: perDay.get(todayKey) ?? 0, last30 };
}

export interface Insight {
  code: string;
  severity: 'info' | 'warn' | 'urgent';
  /** Values the client interpolates into its own localized sentence. */
  values: Record<string, string | number>;
  itemIds?: string[];
}

/** The headline observations shown on the dashboard. */
export function buildInsights(
  userId: string,
  timeZone: string,
  dailyCapacityMinutes: number,
  now = new Date(),
): Insight[] {
  const insights: Insight[] = [];
  const scored = scoreItems(userId, now.getTime());

  const overdue = scored.filter((s) => s.item.dueAt && new Date(s.item.dueAt) < now);
  if (overdue.length) {
    insights.push({
      code: 'overdue',
      severity: overdue.length > 4 ? 'urgent' : 'warn',
      values: { count: overdue.length },
      itemIds: overdue.slice(0, 8).map((s) => s.item.id),
    });
  }

  const load = workloadForecast(userId, timeZone, dailyCapacityMinutes, 7, now);
  const heaviest = [...load].sort((a, b) => b.minutes - a.minutes)[0];
  const overloadedDays = load.filter((d) => d.overloaded);
  if (overloadedDays.length) {
    insights.push({
      code: 'overloaded_days',
      severity: 'warn',
      values: {
        count: overloadedDays.length,
        date: overloadedDays[0].date,
        hours: Math.round((overloadedDays[0].minutes / 60) * 10) / 10,
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

  const deps = dependencyReport(userId);
  if (deps.cycles.length) {
    insights.push({
      code: 'dependency_cycle',
      severity: 'warn',
      values: { count: deps.cycles.length },
      itemIds: deps.cycles[0],
    });
  }

  const dupes = findDuplicates(userId);
  if (dupes.length) {
    insights.push({
      code: 'possible_duplicates',
      severity: 'info',
      values: { count: dupes.length, example: dupes[0].titles.slice(0, 2).join(' / ') },
      itemIds: dupes[0].ids,
    });
  }

  const noDates = scored.filter((s) => !s.item.dueAt);
  if (noDates.length > 6) {
    insights.push({
      code: 'undated_backlog',
      severity: 'info',
      values: { count: noDates.length },
      itemIds: noDates.slice(0, 8).map((s) => s.item.id),
    });
  }

  const streak = streaks(userId, timeZone, now);
  if (streak.current >= 2) {
    insights.push({ code: 'streak', severity: 'info', values: { days: streak.current } });
  }

  const quickWins = scored.filter((s) => !s.blocked && assumedEffort(s.item) <= 15);
  if (quickWins.length >= 3) {
    insights.push({
      code: 'quick_wins',
      severity: 'info',
      values: { count: quickWins.length, minutes: quickWins.slice(0, 5).reduce((n, s) => n + assumedEffort(s.item), 0) },
      itemIds: quickWins.slice(0, 5).map((s) => s.item.id),
    });
  }

  return insights;
}

/**
 * Propose concrete free slots for a task, respecting working hours and the
 * time already committed to reminders that day.
 */
export function suggestSlots(
  userId: string,
  timeZone: string,
  effortMinutes: number,
  options: { workStartHour?: number; workEndHour?: number; days?: number; capacity?: number } = {},
  now = new Date(),
): Array<{ start: string; end: string; dayLoadMinutes: number; rank: number }> {
  const workStart = options.workStartHour ?? 9;
  const workEnd = options.workEndHour ?? 19;
  const days = options.days ?? 7;
  const capacity = options.capacity ?? 240;
  const load = workloadForecast(userId, timeZone, capacity, days, now);

  const suggestions: Array<{ start: string; end: string; dayLoadMinutes: number; rank: number }> = [];
  for (const day of load) {
    const free = Math.max(0, day.capacity - day.minutes);
    if (free < effortMinutes) continue;
    // Start after the busiest part of the morning for loaded days, early otherwise.
    const startHour = Math.min(workEnd - Math.ceil(effortMinutes / 60), workStart + Math.floor(day.minutes / 60));
    if (startHour < workStart) continue;
    const start = new Date(`${day.date}T${String(startHour).padStart(2, '0')}:00:00`);
    if (Number.isNaN(start.getTime())) continue;
    const startMs = Math.max(start.getTime(), now.getTime() + 15 * 60_000);
    suggestions.push({
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + effortMinutes * 60_000).toISOString(),
      dayLoadMinutes: day.minutes,
      rank: Math.round((free / day.capacity) * 100),
    });
  }
  return suggestions.sort((a, b) => b.rank - a.rank).slice(0, 5);
}
