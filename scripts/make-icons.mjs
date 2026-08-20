/**
 * Generates the PWA icons.
 *
 * Written as a tiny PNG encoder rather than pulling in an image library:
 * the icon is a gradient with a geometric glyph, which is a handful of maths,
 * and this keeps the dependency tree free of a native canvas build.
 * Run with: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../web/public');

function crc32(buffer) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const centre = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;

      // Deep space gradient, brighter toward the top-left.
      const glow = Math.max(0, 1 - Math.hypot(u - 0.3, v - 0.25) * 1.6);
      let r = mix(6, 60, glow * 0.9);
      let g = mix(8, 140, glow);
      let b = mix(24, 210, glow);

      // Rounded-square mask so the icon sits well in every launcher.
      const radius = size * 0.22;
      const dx = Math.max(Math.abs(x - centre) - (centre - radius), 0);
      const dy = Math.max(Math.abs(y - centre) - (centre - radius), 0);
      const outside = Math.hypot(dx, dy) - radius;
      const alpha = Math.max(0, Math.min(1, 1 - outside));

      // The diamond glyph — the same "◈" the app uses as its mark.
      const d = (Math.abs(x - centre) + Math.abs(y - centre)) / (size * 0.34);
      const ring = Math.max(0, 1 - Math.abs(d - 1) * 8);
      const core = Math.max(0, 1 - d * 2.6);
      const mark = Math.max(ring, core);
      r = mix(r, 235, mark);
      g = mix(g, 252, mark);
      b = mix(b, 255, mark);

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [192, 512]) {
  const file = path.join(publicDir, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log('wrote', file);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7ce7ff"/>
      <stop offset="1" stop-color="#a68bff"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="24" fill="#05060f"/>
  <path d="M50 16 L74 50 L50 84 L26 50 Z" fill="none" stroke="url(#g)" stroke-width="5"/>
  <path d="M50 36 L62 50 L50 64 L38 50 Z" fill="url(#g)"/>
</svg>`;
writeFileSync(path.join(publicDir, 'icon.svg'), svg);
console.log('wrote', path.join(publicDir, 'icon.svg'));
