/**
 * Built-in alarm tones, synthesized live with the Web Audio API.
 *
 * Nothing is shipped as an audio file: there is no download cost, no
 * licensing question, the tones stay clean at any volume, and an alarm can
 * start ringing the instant it is due without waiting on a network fetch.
 * Each voice returns the time (in seconds) its pattern occupies, so the
 * scheduler knows when to loop it.
 */

export type BuiltinKey =
  | 'chime' | 'marimba' | 'harp' | 'bells' | 'pulse' | 'radar'
  | 'siren' | 'klaxon' | 'digital' | 'birdsong' | 'water' | 'cosmic';

export interface Voice {
  /** Renders one cycle starting at `at`; returns the cycle length in seconds. */
  render(ctx: AudioContext, out: GainNode, at: number): number;
}

const noteFreq = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12);

/** A plucked/struck partial: fast attack, exponential decay. */
function struck(
  ctx: AudioContext,
  out: AudioNode,
  at: number,
  freq: number,
  duration: number,
  type: OscillatorType = 'sine',
  peak = 0.5,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + duration + 0.05);
}

/** Two-operator FM, which is what gives bells and chimes their metallic edge. */
function fmStruck(
  ctx: AudioContext,
  out: AudioNode,
  at: number,
  carrier: number,
  ratio: number,
  index: number,
  duration: number,
  peak = 0.45,
) {
  const osc = ctx.createOscillator();
  const mod = ctx.createOscillator();
  const modGain = ctx.createGain();
  const gain = ctx.createGain();

  osc.frequency.setValueAtTime(carrier, at);
  mod.frequency.setValueAtTime(carrier * ratio, at);
  modGain.gain.setValueAtTime(carrier * index, at);
  modGain.gain.exponentialRampToValueAtTime(carrier * index * 0.02, at + duration * 0.7);

  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  mod.connect(modGain).connect(osc.frequency);
  osc.connect(gain).connect(out);
  mod.start(at);
  osc.start(at);
  mod.stop(at + duration + 0.05);
  osc.stop(at + duration + 0.05);
}

/** White noise buffer, reused for water, birdsong texture and transients. */
let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const length = Math.floor(ctx.sampleRate * 1.2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

function sweep(
  ctx: AudioContext,
  out: AudioNode,
  at: number,
  from: number,
  to: number,
  duration: number,
  type: OscillatorType = 'sine',
  peak = 0.35,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + duration);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(peak, at + duration * 0.15);
  gain.gain.linearRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + duration + 0.05);
}

export const VOICES: Record<BuiltinKey, Voice> = {
  chime: {
    render(ctx, out, at) {
      // A gentle major triad, each note a soft FM bell.
      [0, 4, 7, 12].forEach((semi, i) => {
        fmStruck(ctx, out, at + i * 0.16, noteFreq(semi + 3), 2.01, 1.8, 1.6, 0.32);
      });
      return 2.6;
    },
  },
  marimba: {
    render(ctx, out, at) {
      const pattern = [0, 7, 4, 9];
      pattern.forEach((semi, i) => {
        struck(ctx, out, at + i * 0.14, noteFreq(semi + 3), 0.42, 'sine', 0.5);
        struck(ctx, out, at + i * 0.14, noteFreq(semi + 15), 0.2, 'triangle', 0.14);
      });
      return 1.5;
    },
  },
  harp: {
    render(ctx, out, at) {
      const scale = [0, 2, 4, 7, 9, 12, 16, 19];
      scale.forEach((semi, i) => {
        struck(ctx, out, at + i * 0.075, noteFreq(semi - 5), 1.5 - i * 0.08, 'triangle', 0.3);
      });
      return 2.2;
    },
  },
  bells: {
    render(ctx, out, at) {
      fmStruck(ctx, out, at, noteFreq(-9), 1.41, 3.2, 3.4, 0.4);
      fmStruck(ctx, out, at + 0.02, noteFreq(-9) * 1.006, 2.76, 2.4, 3.0, 0.2);
      fmStruck(ctx, out, at + 1.5, noteFreq(-2), 1.41, 2.8, 2.6, 0.3);
      return 4.2;
    },
  },
  pulse: {
    render(ctx, out, at) {
      for (let i = 0; i < 4; i++) {
        struck(ctx, out, at + i * 0.22, 660, 0.1, 'square', 0.22);
      }
      return 1.6;
    },
  },
  radar: {
    render(ctx, out, at) {
      // The classic rising ping, four times, then a pause.
      for (let i = 0; i < 4; i++) sweep(ctx, out, at + i * 0.42, 620, 1250, 0.3, 'sine', 0.4);
      return 2.4;
    },
  },
  siren: {
    render(ctx, out, at) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.3, at + 0.1);
      for (let i = 0; i < 3; i++) {
        osc.frequency.setValueAtTime(480, at + i * 0.8);
        osc.frequency.linearRampToValueAtTime(980, at + i * 0.8 + 0.4);
        osc.frequency.linearRampToValueAtTime(480, at + i * 0.8 + 0.8);
      }
      gain.gain.setValueAtTime(0.3, at + 2.3);
      gain.gain.linearRampToValueAtTime(0.0001, at + 2.4);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      osc.connect(filter).connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + 2.5);
      return 2.5;
    },
  },
  klaxon: {
    render(ctx, out, at) {
      for (let i = 0; i < 3; i++) {
        const base = at + i * 0.5;
        struck(ctx, out, base, 392, 0.22, 'square', 0.28);
        struck(ctx, out, base, 196, 0.22, 'sawtooth', 0.16);
        struck(ctx, out, base + 0.24, 330, 0.22, 'square', 0.28);
      }
      return 1.9;
    },
  },
  digital: {
    render(ctx, out, at) {
      // Four short beeps then silence — the phone-alarm cadence people know.
      for (let i = 0; i < 4; i++) {
        struck(ctx, out, at + i * 0.16, 1046, 0.09, 'square', 0.24);
      }
      return 1.5;
    },
  },
  birdsong: {
    render(ctx, out, at) {
      const chirp = (start: number, from: number, to: number) => {
        sweep(ctx, out, start, from, to, 0.09, 'sine', 0.28);
        sweep(ctx, out, start + 0.09, to, from * 1.1, 0.07, 'sine', 0.18);
      };
      chirp(at, 2100, 3200);
      chirp(at + 0.3, 1900, 2900);
      chirp(at + 0.52, 2400, 3600);
      chirp(at + 1.1, 2000, 3000);

      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      src.buffer = noise(ctx);
      filter.type = 'bandpass';
      filter.frequency.value = 4200;
      filter.Q.value = 6;
      gain.gain.setValueAtTime(0.02, at);
      gain.gain.linearRampToValueAtTime(0.0001, at + 1.8);
      src.connect(filter).connect(gain).connect(out);
      src.start(at);
      src.stop(at + 1.8);
      return 2.2;
    },
  },
  water: {
    render(ctx, out, at) {
      const drop = (start: number, freq: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        osc.frequency.exponentialRampToValueAtTime(freq * 2.6, start + 0.09);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.4, start + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
        osc.connect(gain).connect(out);
        osc.start(start);
        osc.stop(start + 0.32);
      };
      drop(at, 520);
      drop(at + 0.55, 660);
      drop(at + 1.0, 440);
      return 2.0;
    },
  },
  cosmic: {
    render(ctx, out, at) {
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(300, at);
      filter.frequency.linearRampToValueAtTime(2400, at + 1.6);
      filter.frequency.linearRampToValueAtTime(400, at + 3.4);
      filter.Q.value = 7;

      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.22, at + 0.7);
      gain.gain.linearRampToValueAtTime(0.0001, at + 3.5);
      gain.connect(out);
      filter.connect(gain);

      [-12, -5, 0, 3, 7].forEach((semi, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(noteFreq(semi) * (1 + (i - 2) * 0.002), at);
        osc.connect(filter);
        osc.start(at);
        osc.stop(at + 3.6);
      });
      return 3.8;
    },
  },
};

export const BUILTIN_KEYS = Object.keys(VOICES) as BuiltinKey[];
export const isBuiltinKey = (key: string): key is BuiltinKey => key in VOICES;
