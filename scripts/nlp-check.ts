/**
 * Assertion suite for the multilingual voice parser.
 * Run with: npm run test:nlp
 *
 * These are the phrasings the app promises to understand, in all three
 * languages. Anything that regresses here breaks voice control, so the check
 * exits non-zero and prints the offending case.
 */
import assert from 'node:assert/strict';
import { parseUtterance } from '../web/src/lib/nlp/command';
import type { Item, Locale } from '../web/src/lib/types';

const mk = (id: string, title: string, parentId: string | null = null): Item => ({
  id, parentId, title, notes: '', icon: '', color: '', status: 'open', priority: 2, energy: 3,
  effortMinutes: 0, dueAt: null, startAt: null, recurrence: null, tags: [], blockedBy: [], meta: {},
  position: 0, pinned: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null, deletedAt: null,
});

const items: Item[] = [
  mk('cars', 'Cars'),
  mk('corolla', 'Corolla', 'cars'),
  mk('cruiser', 'Land Cruiser', 'cars'),
  mk('home', 'Home'),
  mk('kitchen', 'Clean the kitchen'),
  mk('dentist', 'Call the dentist'),
  mk('plants', 'Water the plants', 'home'),
  mk('insurance', 'Renew insurance', 'cruiser'),
];

// A fixed Thursday so weekday maths is reproducible.
const NOW = new Date(2026, 7, 20, 10, 0, 0);

interface Expectation {
  intent?: string;
  title?: string;
  parentId?: string | null;
  createsPath?: string[];
  targetId?: string;
  useLast?: boolean;
  when?: string; // 'YYYY-MM-DD HH:mm' in local time
  freq?: string;
  interval?: number;
  byWeekday?: number[];
  priority?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const CASES: Array<{ text: string; locale: Locale; expect: Expectation[] }> = [
  // ── English ──────────────────────────────────────────────────────────────
  {
    text: 'add oil change under cars corolla and remind me tomorrow at eight and add cleaning',
    locale: 'en',
    expect: [
      { intent: 'create', title: 'oil change', parentId: 'corolla' },
      { intent: 'remind', useLast: true, when: '2026-08-21 08:00' },
      { intent: 'create', title: 'cleaning' },
    ],
  },
  {
    text: 'remind me to call the dentist on monday at 9 am',
    locale: 'en',
    expect: [{ intent: 'remind', targetId: 'dentist', when: '2026-08-24 09:00' }],
  },
  { text: 'add cleaning', locale: 'en', expect: [{ intent: 'create', title: 'cleaning' }] },
  {
    text: 'every friday at 6 pm water the plants',
    locale: 'en',
    expect: [{ intent: 'create', title: 'water the plants', when: '2026-08-21 18:00', freq: 'weekly', byWeekday: [5] }],
  },
  {
    text: 'complete clean the kitchen',
    locale: 'en',
    expect: [{ intent: 'complete', targetId: 'kitchen' }],
  },
  {
    text: 'high priority renew insurance next week',
    locale: 'en',
    expect: [{ intent: 'create', title: 'renew insurance', priority: 3, when: '2026-08-27 09:00' }],
  },
  // "and" inside a title must not split the command.
  { text: 'add buy bread and butter', locale: 'en', expect: [{ intent: 'create', title: 'buy bread and butter' }] },
  {
    text: 'remind me in 20 minutes to check the oven',
    locale: 'en',
    expect: [{ intent: 'remind', title: 'check the oven', when: '2026-08-20 10:20' }],
  },
  {
    text: 'add pay the electricity bill on the 15th',
    locale: 'en',
    expect: [{ intent: 'create', title: 'pay the electricity bill', when: '2026-09-15 09:00' }],
  },
  {
    text: 'urgent fix the brakes under cars land cruiser',
    locale: 'en',
    expect: [{ intent: 'create', title: 'fix the brakes', parentId: 'cruiser', priority: 4 }],
  },
  { text: 'delete water the plants', locale: 'en', expect: [{ intent: 'delete', targetId: 'plants' }] },
  {
    text: 'move renew insurance under home',
    locale: 'en',
    expect: [{ intent: 'move', targetId: 'insurance', parentId: 'home' }],
  },
  {
    text: 'add gym every other day at half past six',
    locale: 'en',
    expect: [{ intent: 'create', title: 'gym', freq: 'daily', interval: 2, when: '2026-08-21 06:30' }],
  },

  // ── Arabic (waw-prefixed "and", Arabic-Indic digits, RTL wording) ─────────
  {
    text: 'أضف تغيير الزيت تحت السيارات وذكرني غدا الساعة ثمانية',
    locale: 'ar',
    expect: [
      { intent: 'create', title: 'تغيير الزيت', createsPath: ['السيارات'] },
      { intent: 'remind', useLast: true, when: '2026-08-21 08:00' },
    ],
  },
  {
    text: 'ذكرني أن أتصل بطبيب الأسنان يوم الاثنين الساعة تسعة صباحا',
    locale: 'ar',
    expect: [{ intent: 'remind', title: 'اتصل بطبيب الاسنان', when: '2026-08-24 09:00' }],
  },
  {
    text: 'كل جمعة الساعة ٦ مساء اسق النباتات',
    locale: 'ar',
    expect: [{ intent: 'create', title: 'اسق النباتات', when: '2026-08-21 18:00', freq: 'weekly', byWeekday: [5] }],
  },
  { text: 'أضف تنظيف', locale: 'ar', expect: [{ intent: 'create', title: 'تنظيف' }] },
  {
    text: 'بعد ساعتين ذكرني بالاجتماع',
    locale: 'ar',
    expect: [{ intent: 'remind', when: '2026-08-20 12:00' }],
  },

  // ── Russian ──────────────────────────────────────────────────────────────
  {
    text: 'добавь замену масла в машины и напомни завтра в восемь',
    locale: 'ru',
    expect: [
      { intent: 'create', title: 'замену масла' },
      { intent: 'remind', useLast: true, when: '2026-08-21 08:00' },
    ],
  },
  {
    text: 'напомни позвонить стоматологу в понедельник в девять утра',
    locale: 'ru',
    expect: [{ intent: 'remind', title: 'позвонить стоматологу', when: '2026-08-24 09:00' }],
  },
  {
    text: 'каждую пятницу в шесть вечера полить цветы',
    locale: 'ru',
    expect: [{ intent: 'create', title: 'полить цветы', when: '2026-08-21 18:00', freq: 'weekly', byWeekday: [5] }],
  },
  {
    text: 'через 20 минут проверить духовку',
    locale: 'ru',
    expect: [{ intent: 'create', title: 'проверить духовку', when: '2026-08-20 10:20' }],
  },
];

let failures = 0;
let checks = 0;

for (const testCase of CASES) {
  const { commands } = parseUtterance(testCase.text, { items, locale: testCase.locale, now: NOW });
  try {
    assert.equal(
      commands.length,
      testCase.expect.length,
      `expected ${testCase.expect.length} command(s), got ${commands.length}`,
    );

    testCase.expect.forEach((want, index) => {
      const got = commands[index];
      const where = `command ${index + 1}`;
      assert.ok(!got.problem, `${where}: unexpected problem "${got.problem}"`);

      if (want.intent) assert.equal(got.intent, want.intent, `${where}: intent`);
      if (want.title) assert.equal(got.summary.title, want.title, `${where}: title`);
      if (want.parentId !== undefined) assert.equal(got.summary.parentId, want.parentId, `${where}: parent`);
      if (want.createsPath) assert.deepEqual(got.summary.createsPath, want.createsPath, `${where}: new path`);
      if (want.targetId) assert.equal(got.summary.targetId, want.targetId, `${where}: target`);
      if (want.useLast) {
        assert.equal(
          got.op && 'target' in got.op ? got.op.target.useLast : undefined,
          true,
          `${where}: should attach to the item created just before it`,
        );
      }
      if (want.when) assert.equal(got.summary.when ? stamp(got.summary.when) : null, want.when, `${where}: when`);
      if (want.freq) assert.equal(got.summary.recurrence?.freq, want.freq, `${where}: repeat frequency`);
      if (want.interval) assert.equal(got.summary.recurrence?.interval, want.interval, `${where}: repeat interval`);
      if (want.byWeekday) assert.deepEqual(got.summary.recurrence?.byWeekday, want.byWeekday, `${where}: weekdays`);
      if (want.priority !== undefined) assert.equal(got.summary.priority, want.priority, `${where}: priority`);
      checks++;
    });
    console.log(`  ok  [${testCase.locale}] ${testCase.text}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  [${testCase.locale}] ${testCase.text}`);
    console.error(`      ${(error as Error).message}`);
    console.error(`      parsed: ${JSON.stringify(commands.map((c) => ({ intent: c.intent, ...c.summary })), null, 2)}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} utterances parsed as expected (${checks} assertions).`);
if (failures) process.exit(1);
