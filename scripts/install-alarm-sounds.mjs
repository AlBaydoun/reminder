/**
 * Put the alarm tones where each platform expects to find them.
 *
 * Android reads notification sounds from res/raw and iOS from the app bundle,
 * so the same files have to exist under two different names in two different
 * trees. They are copied rather than committed twice: the platform copies are
 * build output, and git holds one master set in assets/alarm-tones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TONES = path.join(ROOT, 'assets/alarm-tones');
const TARGETS = [
  path.join(ROOT, 'web/android/app/src/main/res/raw'),
  path.join(ROOT, 'web/ios/App/App/sounds'),
];

if (!fs.existsSync(TONES)) {
  console.error(`No tones in ${path.relative(ROOT, TONES)} — run "npm run sounds" to render them.`);
  process.exit(1);
}

const files = fs.readdirSync(TONES).filter((f) => f.endsWith('.wav'));
if (!files.length) {
  console.error('No tones to install — an alarm with no sound is not an alarm.');
  process.exit(1);
}

let copied = 0;
for (const target of TARGETS) {
  // Only where the platform actually exists: a checkout with just Android
  // should not be told off about a missing iOS project.
  if (!fs.existsSync(path.dirname(target)) && !fs.existsSync(path.dirname(path.dirname(target)))) continue;
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) {
    const to = path.join(target, file);
    const from = path.join(TONES, file);
    // Skip an identical copy so a rebuild does not churn the platform tree.
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
    fs.copyFileSync(from, to);
    copied++;
  }
}
console.log(`alarm tones: ${files.length} available, ${copied} copied into the platform projects`);
