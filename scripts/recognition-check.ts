/**
 * Assertion suite for the $P shape/gesture recognizer.
 * Run with: npm run test:recognition
 *
 * Inputs are deliberately messy — random jitter, uneven sampling, a different
 * scale and offset from the templates — because that is what a real pen stroke
 * looks like. A recognizer that only passes on clean input is not useful.
 */
import { recognize, toCloud } from '../web/src/lib/recognition/pointcloud';
import { ALL_TEMPLATES } from '../web/src/lib/recognition/templates';

// Simulate hand-drawn input: noisy, uneven sampling, arbitrary scale/offset.
function jitter(points: Array<[number, number]>, amount = 3, scale = 2.4, ox = 130, oy = 70) {
  return points.map(([x, y]) => ({
    x: x * scale + ox + (Math.random() - 0.5) * amount,
    y: y * scale + oy + (Math.random() - 0.5) * amount,
  }));
}
const seg = (a: [number, number], b: [number, number], n = 9): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / (n - 1), a[1] + ((b[1] - a[1]) * i) / (n - 1)]);
const circlePts = (n = 30, rx = 40, ry = 40): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [50 + rx * Math.cos((i / n) * Math.PI * 2), 50 + ry * Math.sin((i / n) * Math.PI * 2)]);
const starPts = (): Array<[number, number]> => {
  const v: Array<[number, number]> = [];
  for (let i = 0; i <= 10; i++) {
    const r = i % 2 === 0 ? 45 : 18;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    v.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  const out: Array<[number, number]> = [];
  for (let i = 1; i < v.length; i++) out.push(...seg(v[i - 1], v[i], 5));
  return out;
};

const cases: Array<[string, Array<Array<[number, number]>>]> = [
  ['check', [[...seg([2, 52], [29, 88]), ...seg([29, 88], [96, 7])]]],
  ['circle', [circlePts()]],
  ['star', [starPts()]],
  ['strike', [seg([0, 50], [100, 47], 20)]],
  ['triangle', [[...seg([50, 5], [95, 90]), ...seg([95, 90], [5, 90]), ...seg([5, 90], [50, 5])]]],
  ['rectangle', [[...seg([5, 15], [95, 15]), ...seg([95, 15], [95, 85]), ...seg([95, 85], [5, 85]), ...seg([5, 85], [5, 15])]]],
  ['cross', [seg([10, 10], [90, 90], 14), seg([90, 10], [10, 90], 14)]],
  ['arrow', [seg([0, 50], [80, 50], 18), [...seg([55, 22], [82, 50], 8), ...seg([82, 50], [55, 78], 8)]]],
  ['caret', [[...seg([10, 80], [50, 15]), ...seg([50, 15], [90, 80])]]],
  ['7', [[...seg([14, 10], [86, 10]), ...seg([86, 10], [40, 92])]]],
  ['1', [[...seg([28, 22], [50, 8]), ...seg([50, 8], [50, 92])]]],
  ['0', [circlePts(30, 32, 45)]],
];

let pass = 0;
for (const [expected, strokes] of cases) {
  const cloud = toCloud(strokes.map((s) => ({ points: jitter(s) })));
  const result = recognize(cloud, ALL_TEMPLATES);
  const ok = result?.name === expected;
  if (ok) pass++;
  console.log(
    `${ok ? ' ok ' : 'FAIL'}  expected=${expected.padEnd(10)} got=${(result?.name ?? '—').padEnd(10)} score=${result?.score.toFixed(3)}  runnerUp=${result?.runnerUp?.name}(${result?.runnerUp?.score.toFixed(2)})`,
  );
}
console.log(`\n${pass}/${cases.length} shapes recognized`);
if (pass < cases.length) process.exit(1);
