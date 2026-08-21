/**
 * Are the rendered alarm tones actually audible, and do they start at once?
 *
 * Sparseness is not a fault: a water drop and a digital beep are mostly
 * silence by design. What would be a fault is a tone that is quiet, that is
 * empty, or that takes a second to begin — an alarm has to be loud from its
 * first moment.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIRS = ['assets/alarm-tones'];
const MIN_RMS = 0.02;
const MIN_PEAK = 0.5;
const MUST_START_WITHIN = 0.5;

let failed = 0;
for (const dir of DIRS) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.wav')) : [];
  console.log(`\n${dir}  (${files.length} tones)`);
  if (!files.length) { console.log('  FAIL  no tones rendered'); failed++; continue; }

  for (const file of files.sort()) {
    const b = fs.readFileSync(path.join(dir, file));
    const header =
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WAVE' &&
      b.readUInt16LE(20) === 1;
    const channels = b.readUInt16LE(22);
    const rate = b.readUInt32LE(24);
    const bits = b.readUInt16LE(34);
    const dataSize = b.readUInt32LE(40);
    const samples = dataSize / 2;

    let sum = 0;
    let peak = 0;
    let firstSound = Infinity;
    for (let i = 0; i < samples; i++) {
      const v = b.readInt16LE(44 + i * 2) / 32768;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (firstSound === Infinity && a > 0.05) firstSound = i / rate;
    }
    const rms = Math.sqrt(sum / samples);
    const seconds = samples / rate;

    const ok =
      header && channels === 1 && bits === 16 && dataSize === b.length - 44 &&
      rms >= MIN_RMS && peak >= MIN_PEAK && firstSound <= MUST_START_WITHIN && seconds > 2;
    if (!ok) failed++;
    console.log(
      `  ${ok ? ' ok  ' : 'FAIL '} ${file.padEnd(20)} ${seconds.toFixed(1)}s ${rate}Hz` +
        `  rms ${rms.toFixed(3)}  peak ${peak.toFixed(2)}  starts ${firstSound.toFixed(2)}s`,
    );
  }
}
console.log(failed ? `\n${failed} tone(s) would not do their job` : '\nevery tone is loud, prompt and well-formed');
process.exit(failed ? 1 : 0);
