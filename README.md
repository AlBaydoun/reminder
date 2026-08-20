# Nexus

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
| **Pen & handwriting** | Pressure- and tilt-aware drawing. Handwriting is read by the browser's own engine where one exists; shapes, digits and pen gestures are read everywhere by a built-in recognizer. Draw a checkmark to complete a task, a star to pin it, a strike to delete it. |
| **3D Galaxy** | Categories as living worlds. Size tracks how much is inside, a ring shows completion, overdue worlds pulse, and tasks orbit as moons. |
| **Backups** | A full copy of every account is written every night, plus a byte-exact database snapshot. Rotation, restore-with-safety-copy, manual export and import. |
| **Languages** | English, العربية (full RTL) and Русский — interface *and* voice grammar. |

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

Two layers. Where the browser has a **Handwriting Recognition API** (Chrome on
ChromeOS and Windows) that is used for real text — cursive, sentences, on
device. Everywhere else a built-in **$P point-cloud recognizer** reads shapes,
digits and pen gestures. $P needs no training data, no model download and no
network, and does not care about stroke order.

It is **not** a general handwriting engine, and the interface says so rather
than implying otherwise.

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
      recognition/         $P recognizer, templates, handwriting API
      audio/               synthesized tones, playback
    store/                 auth, data, ui, alarms, voice
    three/                 galaxy scene, nebula shader
    views/                 today, galaxy, list, focus, timeline,
                           alarms, draw, insights, settings, trash
    i18n/                  en, ar, ru
scripts/
  nlp-check.ts             22 utterances, 3 languages
  recognition-check.ts     12 shapes with simulated hand jitter
  make-icons.mjs           PWA icons, generated (no image dependency)
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
- **Handwriting-to-text** falls back to shapes, digits and gestures where the
  platform has no handwriting engine.
- **Single server, single region.** No multi-device conflict resolution beyond
  last-write-wins; the server is the single source of truth.

## Next

The natural next step is packaging with Capacitor for iOS and Android, where
the alarm limitation disappears: real background alarms, the system ringtone
picker, and pencil input with full pressure and tilt.
