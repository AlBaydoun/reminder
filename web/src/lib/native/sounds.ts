import { isAndroid, loadLocalNotifications } from './bridge';

/**
 * Alarm sound on a phone.
 *
 * Two facts drive this file.
 *
 * The OS plays the sound from a file while the app is not running, so the
 * synthesized tones are rendered to WAV at build time (see
 * scripts/render-alarm-sounds.mjs) and shipped in the app.
 *
 * And on Android a notification's sound belongs to its *channel*, not to the
 * notification — and a channel's sound is fixed the moment it is created.
 * Changing an alarm's tone therefore means posting it on a different channel,
 * so there is one channel per tone, created on demand.
 */

const BUILTIN_PREFIX = 'builtin:';

/**
 * The tone files that ship with the app, keyed the way the rest of the app
 * names them. Kept explicit rather than derived so a missing render is a
 * compile-time-visible gap rather than a silent alarm.
 */
const BUILTIN_FILES: Record<string, string> = {
  chime: 'nexus_chime.wav',
  marimba: 'nexus_marimba.wav',
  harp: 'nexus_harp.wav',
  bells: 'nexus_bells.wav',
  pulse: 'nexus_pulse.wav',
  radar: 'nexus_radar.wav',
  siren: 'nexus_siren.wav',
  klaxon: 'nexus_klaxon.wav',
  digital: 'nexus_digital.wav',
  birdsong: 'nexus_birdsong.wav',
  water: 'nexus_water.wav',
  cosmic: 'nexus_cosmic.wav',
};

const DEFAULT_FILE = BUILTIN_FILES.chime;

/**
 * A sound the user picked from their own phone, remembered as a content URI.
 * Kept apart from the built-ins because it is a device path, not a bundled
 * asset, and it has to survive between runs.
 */
const DEVICE_PREFIX = 'device:';

/** The file the OS should play for this reminder's sound id. */
export async function nativeSoundFor(soundId: string | null | undefined): Promise<string> {
  if (!soundId) return DEFAULT_FILE;

  if (soundId.startsWith(DEVICE_PREFIX)) {
    // Android takes a content:// URI straight through; the picker stored it.
    return soundId.slice(DEVICE_PREFIX.length);
  }

  const key = soundId.startsWith(BUILTIN_PREFIX) ? soundId.slice(BUILTIN_PREFIX.length) : soundId;
  const file = BUILTIN_FILES[key];
  if (file) return file;

  // An uploaded sound lives on the server, which the OS cannot reach while the
  // app is closed. Falling back to a bundled tone means the alarm still rings;
  // going silent because a file was unreachable would be the worse failure.
  return DEFAULT_FILE;
}

/** Stable channel id for a tone. One channel per sound, as Android requires. */
export function channelIdFor(soundId: string | null | undefined, quiet = false): string {
  const raw = (soundId ?? 'builtin:chime').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  return `nexus_${quiet ? 'lead_' : 'alarm_'}${raw}`;
}

const created = new Set<string>();

/**
 * Create a channel if it does not exist yet.
 *
 * `createChannel` is idempotent on Android, but it is also a bridge round trip
 * per notification, so the ones already made this run are remembered.
 */
export async function ensureChannel(
  channelId: string,
  sound: string,
  quiet: boolean,
  vibrate: boolean,
): Promise<void> {
  if (!isAndroid() || created.has(channelId)) return;
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications) return;
  try {
    await LocalNotifications.createChannel({
      id: channelId,
      name: quiet ? 'Nexus pre-alerts' : 'Nexus alarms',
      description: quiet
        ? 'A quiet heads-up before an alarm is due.'
        : 'Alarms for your tasks and reminders.',
      // MAX is what earns a heads-up notification and a sound on the lock
      // screen; anything lower can be shown silently by the system.
      importance: quiet ? 3 : 5,
      visibility: 1,
      sound,
      vibration: vibrate,
      lights: true,
      lightColor: '#7C6BFF',
    });
    created.add(channelId);
  } catch {
    /* the notification still posts on the default channel */
  }
}

/** Every channel this app has made, so settings can offer to tidy them. */
export async function listChannels(): Promise<{ id: string; name: string; sound?: string }[]> {
  const LocalNotifications = await loadLocalNotifications();
  if (!LocalNotifications || !isAndroid()) return [];
  try {
    const result = await LocalNotifications.listChannels();
    return result.channels
      .filter((c) => c.id.startsWith('nexus_'))
      .map((c) => ({ id: c.id, name: c.name, sound: c.sound }));
  } catch {
    return [];
  }
}

export { BUILTIN_FILES, DEVICE_PREFIX };
