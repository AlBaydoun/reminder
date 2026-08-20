# Nexus

**[▶ Try the live demo](https://albaydoun.github.io/reminder/)** — no sign-up,
nothing to install. Everything you do stays in your own browser.

A voice-driven to-do list and reminder system built around one idea:

> **A category and a task are the same thing.**
> "Cars" holds a child per vehicle, so it reads as a category.
> "Clean the kitchen" holds nothing, so it reads as a task.
> Add something inside a task and it becomes a category — no conversion, no
> separate concept, no migration.

There is one `items` table. A row with children renders as a category with a
progress ring; a leaf renders as a checkbox. Either can carry alarms, a due
date, a repeat rule, notes and sketches.

---

## What it does

| | |
|---|---|
| **Voice control** | Speak one sentence containing several commands. "add oil change under cars corolla and remind me tomorrow at eight and add cleaning" becomes three operations, applied atomically, with one-tap undo. English, Arabic and Russian. |
| **Alarms** | Multiple simultaneous alarms, twelve synthesized tones, your own uploaded sounds (on a phone the picker opens your music and ringtones), snooze, escalating ring, pre-alerts, and repeats down to "every other day at half past six". |
| **Reasoning** | A ranked focus queue that explains *why* each item is where it is, workload forecasting against your daily capacity, dependency-cycle detection, near-duplicate detection, and auto-categorisation learned from your own tree. |
| **Handwriting** | Write a task by hand and it stays handwritten — the ink is the row. The transcription becomes the title, so it is searchable, completable, schedulable and voice-addressable like any typed entry. Read by the browser's own engine where one exists, and by a built-in reader everywhere else. |
| **Brushes & fonts** | Fifteen brushes — fineliner, ballpoint, fountain, calligraphy, brush pen, marker, pencil, charcoal, crayon, highlighter, airbrush, neon, dashed, ribbon, eraser — driven by pressure, tilt and speed. Forty-one typefaces for the canvas text tool and the interface. Draw a checkmark to complete a task, a star to pin it, a strike to delete it. |
| **3D Galaxy** | Categories as living worlds. Size tracks how much is inside, a ring shows completion, overdue worlds pulse, and tasks orbit as moons. |
| **Backups** | A full copy of every account is written every night, plus a byte-exact database snapshot. Rotation, restore-with-safety-copy, manual export and import. |
| **Languages** | English, العربية (full RTL) and Русский — interface *and* voice grammar. |

---

## The live demo

<https://albaydoun.github.io/reminder/>

GitHub Pages serves static files only, so it cannot run the Node/SQLite server.
The published build therefore swaps the API client for an implementation of the
**same surface** backed by IndexedDB (`VITE_DEMO=true`), so the page is the real
app with a backend that lives in your browser. TypeScript checks that swap: the
demo backend is assigned to `typeof serverApi`, so it cannot drift from the real
client without failing the build.

Working in the demo: voice commands, alarms with all twelve synthesized tones
and your own uploaded sounds, the pen recognizer, the 3D Galaxy, every reasoning
view, local snapshots and export/import. It opens on a seeded workspace with
real dates so no panel is empty, and **Reset demo** wipes it.

Not in the demo, and said so on the page rather than discovered by losing
something: syncing between devices, and the nightly backup — that is a server
cron job, so the demo offers on-demand local snapshots instead.

Build it yourself with `npm run build:demo` (`VITE_BASE` sets the sub-path), or
`npm run preview:demo` to serve it locally. Pushing to the default branch
rebuilds and republishes it through `.github/workflows/pages.yml`, gated behind
the typecheck and both test suites.

---

## Running it

```bash
npm install
cp server/.env.example server/.env     # then set JWT_SECRET (see below)
npm run dev                            # API on :4000, app on :5173
```

Open <http://localhost:5173> and create an account. A new account is seeded
with a small example tree so the category/task idea is visible immediately.

### Production

```bash
npm run build
NODE_ENV=production JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") npm start
```

The API server also serves the built front-end, so there is one process to
deploy and the session cookie stays same-origin. Everything lives at
<http://localhost:4000>.

### Tests

```bash
npm test              # voice parser + shape recognizer
npm run test:nlp      # 22 utterances across the three languages
npm run test:recognition
npm run typecheck
```

---

## Configuration

`server/.env` — see `server/.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `JWT_SECRET` | *(dev: generated)* | **Required in production.** In development a secret is generated once and written to `data/.dev-jwt-secret` so restarts do not sign everyone out. |
| `DATA_DIR` | `./data` | SQLite database and backups. |
| `BACKUP_CRON` | `0 3 * * *` | Nightly backup time, server local time. |
| `BACKUP_KEEP_DAILY` | `30` | Nightly snapshots retained. |
| `BACKUP_KEEP_MONTHLY` | `12` | Months retained beyond the daily window. |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated. Same-origin requests are always allowed. |
| `ALLOW_SIGNUP` | `true` | Set `false` to close registration once your account exists. |

---

## How the pieces work

### Voice

The pipeline is: **Web Speech API → split → classify → extract → resolve →
confirm → batch apply → undo.**

Splitting is the subtle part. Cutting on every "and" would turn "buy bread and
butter" into two tasks, so a connector only splits when the text after it
actually begins a new instruction. Arabic writes "and" as a **و** glued to the
following word (`وذكرني` = "and remind me"), so it is detached first wherever
the remainder is a known verb.

Category references are resolved **against your real tree, in the browser**, so
"under cars corolla" becomes a concrete node before anything is sent, and the
confirmation sheet can show exactly where the item will land.

Two bugs worth recording, because both fail *silently*:

- JavaScript's `\b` word boundary is defined over ASCII word characters only,
  so `\bالاثنين\b` and `\bпонедельник\b` match **nothing**. The parser uses
  Unicode-aware lookarounds instead.
- `THREE.Color` cannot parse the space-separated CSS Color 4 form
  `hsl(200 78% 62%)` and silently returns white, which turned every untinted
  world in the Galaxy view grey.

Supported phrasing includes relative offsets ("in 20 minutes", "بعد ساعتين",
"через 20 минут"), weekdays, month/day dates, ordinals ("on the 15th"),
day parts ("in the morning", "مساء", "вечером"), spoken numerals ("at eight",
"الساعة ثمانية", "в восемь"), Arabic-Indic digits, and repeats ("every Friday
at 6 pm", "every other day", "كل جمعة", "каждую пятницу").

### Alarms

The engine runs a **one-second ticker**, not a `setTimeout` per alarm: long
timeouts are throttled in background tabs and are simply wrong after a device
sleeps, while comparing wall-clock time every second is immune to both. The
server owns *when* an alarm is due and reports its own clock with every poll,
so a wrong device clock cannot fire alarms early. An alarm whose time passed
while the app was closed still rings on the next open.

Tones are synthesized with the Web Audio API rather than shipped as files — no
download, no licensing, and they stay clean at any volume. FM synthesis for
bells and chimes, filtered noise for water and birdsong, swept oscillators for
sirens and radar.

**A web app cannot ring reliably with its tab closed.** Nexus says so in the
interface rather than pretending otherwise: it asks for notification
permission, primes the audio context on your first interaction, and recommends
installing to the home screen. This is the main thing a native build will fix.

### Reasoning

Every score carries its reasons, because a number with no explanation is a
number to distrust.

```
score = 0.42·urgency + 0.34·importance + 0.12·quick-win + 0.12·staleness
      + 4·(items this unblocks)          … ×0.15 when blocked
```

Urgency decays exponentially with time-to-due; overdue work is pinned near the
top but grows slowly so a month-old item cannot bury everything due today.
Auto-categorisation scores each category as a bag of words drawn from its
descendants, weighted by inverse document frequency, so distinctive words
("tyres") count far more than common ones ("buy").

### Handwriting

**A handwritten entry is an entry.** It keeps your ink as its face in the list,
and the transcription becomes its title — which is what search, voice, the
focus ranking and the reasoning engine all read. It has a checkbox, a due date,
alarms and a place in the tree, exactly like a typed row. Complete it and the
handwriting is struck through, the way you would on paper.

Reading happens in three layers:

1. **Pen gestures.** One or two strokes that form a checkmark, star, circle or
   strike are an instruction, not writing, and are caught first.
2. **The platform engine** where one exists (Chrome on ChromeOS and Windows) —
   true on-device recognition, cursive included.
3. **Nexus's own reader** everywhere else. Strokes are split into lines, lines
   into characters, and each character is matched with the same $P point-cloud
   recognizer used for shapes. Word breaks are found by comparing each gap
   against the other gaps on the line rather than against a fixed threshold,
   because the blank to the right of a "p" is wider than the gap after an "l".

Two things scaling throws away had to be put back, because $P normalises
before matching:

- **Aspect ratio.** A dash, a "1" and an "l" are the same point cloud once
  scaled; the template's original proportions are kept and used as a prior.
- **Size relative to the line.** A full stop and a lower-case "o" are both just
  a circle. Height against the tallest thing on the line is the only thing that
  separates them.

`scripts/handwriting-check.ts` synthesises words with per-letter jitter,
varying size, uneven spacing and slant, and requires 90% character accuracy —
it currently reads 10/10 phrases exactly.

It reads **separated print, not joined cursive**, so the transcription is
always shown in an editable field and never applied silently. It appears as you
write, so most of the time correcting it is one keystroke or none.

### Brushes

Each brush is a set of physical parameters rather than a bespoke routine — how
much pressure changes the width, how much speed thins the line, whether the nib
is round or a chisel, how grainy the deposit is. A fountain pen that swells on
the downstroke and a charcoal stick that drags come out of the same code path.

Pressure response is applied only to real pen input: a mouse reports a constant
0.5, so responding to it would make every brush the same slightly-wrong
thickness. Finished strokes live on a second offscreen canvas and only the
stroke under the pen is repainted each frame, so a page of charcoal does not
turn drawing into a slideshow.

### Backups

Every night: one self-contained JSON export per account (custom alarm sounds
base64-inlined — a backup that loses your alarm tones is not a backup) plus a
byte-exact SQLite snapshot taken through the online backup API, safe to run
while serving. Rotation keeps the last 30 nights plus one per month. If the
process was down at the scheduled hour, a catch-up pass runs shortly after
boot. Restoring always writes a safety copy first.

---

## Layout

```
server/
  src/
    db.ts                  schema + append-only migrations
    auth.ts                rotating refresh tokens, reuse detection
    backup.ts              nightly job, rotation, restore
    lib/
      recurrence.ts        RFC-5545 subset, DST-correct via Intl
      time.ts              timezone maths without a date library
      reasoning.ts         scoring, forecasting, dependencies, duplicates
      items.ts             tree helpers, cycle-safe reparenting
    routes/                auth, items, reminders, sounds, drawings,
                           backups, brain, batch
web/
  src/
    lib/
      nlp/                 lexicon, numbers, datetime, command parser
      recognition/         $P recognizer, glyph templates, word reader
      brushes.ts           the fifteen brushes
      fonts.ts             the typeface library
      inkWriter.ts         writes text as strokes; renders ink to an image
      audio/               synthesized tones, playback
    store/                 auth, data, ui, alarms, voice
    three/                 galaxy scene, nebula shader
    views/                 today, galaxy, list, focus, timeline,
                           alarms, draw, insights, settings, trash
    i18n/                  en, ar, ru
    lib/
      api.ts               picks the backend at build time
      serverApi.ts         talks to the Node server
      demo/                the whole backend, in the browser (Pages build)
scripts/
  nlp-check.ts             22 utterances, 3 languages
  recognition-check.ts     12 shapes with simulated hand jitter
  handwriting-check.ts     10 handwritten phrases, 90% character-accuracy floor
  make-icons.mjs           PWA icons, generated (no image dependency)
.github/workflows/
  pages.yml                typecheck, test, build the demo, deploy to Pages
```

---

## Keyboard

| | |
|---|---|
| `⌘K` / `Ctrl+K` | Search everything |
| `⌘J` / `Ctrl+J` | Voice |
| `Esc` | Close |
| `↑ ↓ ⏎` | Move and choose in search |

---

## Known limits

- **Background ringing.** Browsers will not run timers reliably in a closed
  tab. Installing to the home screen helps; a native build is the real fix.
- **Speech recognition** needs Chrome, Edge or Safari, and most
  implementations send audio to the vendor's servers.
- **Handwriting** reads separated print, not joined cursive. The transcription
  is always editable, and the ink is kept whatever the reader made of it.
- **Fonts** are fetched from Google Fonts the first time each is used. Offline,
  the fallback stack takes over and nothing breaks.
- **Single server, single region.** No multi-device conflict resolution beyond
  last-write-wins; the server is the single source of truth.
- **The demo is per-browser.** Clearing site data clears the workspace, and
  nothing syncs. Run the server build for real use.

## Next

The natural next step is packaging with Capacitor for iOS and Android, where
the alarm limitation disappears: real background alarms, the system ringtone
picker, and pencil input with full pressure and tilt.
