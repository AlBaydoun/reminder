/**
 * Turn the synthesized alarm tones into audio files for the phone builds.
 *
 * On the web the tones are generated live, which is why the app ships no audio
 * at all. A phone notification cannot do that: the OS plays the sound, from a
 * file, while the app is not running. So the same voices are rendered ahead of
 * time — by the real synth, in a real Web Audio implementation, through
 * OfflineAudioContext in headless Chromium. Reimplementing them in Node would
 * have meant two definitions of "chime" drifting apart; this way there is
 * still exactly one, and the alarm on the phone is the alarm in the browser.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * One committed copy, not two.
 *
 * Both platforms need the same bytes in different places, so the tones live
 * here and `scripts/install-alarm-sounds.mjs` copies them into each platform
 * project at build time. Committing them twice would double eight megabytes
 * of identical audio for no reason, and committing neither would mean the
 * phone app could not be built without a browser to re-render them.
 */
const TONES = path.join(ROOT, 'assets/alarm-tones');

/** Long enough to be heard and act on, short enough for a notification sound. */
const TARGET_SECONDS = 8;
/**
 * 22.05 kHz, not CD rate.
 *
 * These are alarm tones played through a phone speaker, and uncompressed audio
 * is the only format iOS accepts for a notification sound — so the choice is
 * between file size and a ceiling of 11 kHz. Halving the rate halves eight
 * megabytes per platform, and nothing in a chime or a siren lives above 11 kHz
 * that a phone speaker could reproduce anyway.
 */
const SAMPLE_RATE = 22050;

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function bundleSynth() {
  const result = await build({
    entryPoints: [path.join(ROOT, 'web/src/lib/audio/synth.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'NexusSynth',
    write: false,
    target: 'es2020',
  });
  return result.outputFiles[0].text;
}

const RENDER_IN_PAGE = async ({ targetSeconds, sampleRate }) => {
  // eslint-disable-next-line no-undef
  const { VOICES, BUILTIN_KEYS } = window.NexusSynth;
  const out = {};

  for (const key of BUILTIN_KEYS) {
    const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * targetSeconds), sampleRate);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    // Repeat the voice's own cycle until the file is full, exactly as the live
    // player loops it, so a rendered file and a live alarm have the same pulse.
    let at = 0;
    let guard = 0;
    while (at < targetSeconds && guard++ < 200) {
      const cycle = VOICES[key].render(ctx, master, at);
      at += Math.max(0.15, cycle);
    }

    const buffer = await ctx.startRendering();
    const samples = buffer.getChannelData(0);

    // 16-bit PCM WAV. Every phone plays it, and it needs no encoder.
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const view = new DataView(new ArrayBuffer(44 + dataSize));
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, dataSize, true);

    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    // Normalise to just under full scale: a quiet alarm is a missed alarm, and
    // the phone's own volume slider is the right place to make it quieter.
    const scale = peak > 0 ? 0.94 / peak : 1;

    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i] * scale));
      view.setInt16(44 + i * bytesPerSample, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }

    let binary = '';
    const bytes = new Uint8Array(view.buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    out[key] = { data: btoa(binary), peak, seconds: buffer.duration };
  }
  return out;
};

/**
 * Playwright is not a dependency of this project.
 *
 * Rendering the tones is a rare maintenance task — they are committed, so a
 * normal build and CI never need it — and making every install pull a few
 * hundred megabytes of browser for one script would be a poor trade. It is
 * asked for only when this script actually runs.
 */
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'This script renders audio through a real Web Audio implementation, which needs a browser.\n' +
      'Install it just for this:  npm i -D playwright && npx playwright install chromium\n' +
      '(The tones are committed in assets/alarm-tones, so you only need this to change them.)',
  );
  process.exit(1);
}

const bundle = await bundleSynth();

const browser = await chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.addScriptTag({ content: bundle });
const rendered = await page.evaluate(RENDER_IN_PAGE, { targetSeconds: TARGET_SECONDS, sampleRate: SAMPLE_RATE });
await browser.close();

fs.mkdirSync(TONES, { recursive: true });

let total = 0;
console.log('rendering alarm tones\n');
for (const [key, info] of Object.entries(rendered)) {
  const buffer = Buffer.from(info.data, 'base64');
  // Android resource names allow only lowercase letters, digits and underscore.
  const name = `nexus_${key.replace(/[^a-z0-9]/g, '_')}.wav`;
  fs.writeFileSync(path.join(TONES, name), buffer);
  total += buffer.length;
  const silent = info.peak < 0.001;
  console.log(
    ` ${silent ? 'FAIL' : ' ok '}  ${name.padEnd(22)} ${(buffer.length / 1024).toFixed(0).padStart(4)} KB` +
      `  ${info.seconds.toFixed(1)}s  peak ${info.peak.toFixed(3)}`,
  );
  if (silent) process.exitCode = 1;
}
console.log(`\n${Object.keys(rendered).length} tones, ${(total / 1024 / 1024).toFixed(2)} MB in ${path.relative(ROOT, TONES)}`);
if (process.exitCode) console.log('\nA silent tone means the voice rendered nothing — that alarm would not ring.');
