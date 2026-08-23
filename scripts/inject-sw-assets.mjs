/**
 * Tell the service worker which files to precache.
 *
 * Asset filenames carry a content hash, so a static `sw.js` cannot know them.
 * They still have to be precached: the page's own scripts are requested before
 * the worker takes control, so on a first visit they never reach its fetch
 * handler and would be missing from the cache exactly when the connection
 * disappears — an installed app that will not start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'web/dist');
const SW = path.join(DIST, 'sw.js');

if (!fs.existsSync(SW)) {
  console.log('no service worker in the build — nothing to do');
  process.exit(0);
}

function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
    return [rel];
  });
}

const assets = walk(path.join(DIST, 'assets'), 'assets')
  // Source maps are for debugging, not for running offline, and they are large.
  .filter((file) => !file.endsWith('.map'));

const source = fs.readFileSync(SW, 'utf8');
const declaration = `self.__NEXUS_ASSETS__ = ${JSON.stringify(assets)};\n`;

// Idempotent: re-running must not stack declarations on top of each other.
const cleaned = source.replace(/^self\.__NEXUS_ASSETS__ = .*\n/, '');
fs.writeFileSync(SW, declaration + cleaned);

const bytes = assets.reduce((sum, file) => sum + fs.statSync(path.join(DIST, file)).size, 0);
console.log(`service worker will precache ${assets.length} files (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
