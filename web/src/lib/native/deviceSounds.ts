import { isAndroid, isNative } from './bridge';
import { DEVICE_PREFIX } from './sounds';

/**
 * "Use a sound from my phone."
 *
 * This was in the original brief and the web build can only half-answer it: a
 * browser can accept an uploaded file, but it cannot reach into the ringtones
 * the phone already has. The native builds can, through a small plugin on each
 * side — the system ringtone picker on Android, a file picker writing into
 * Library/Sounds on iOS, because iOS does not let an app read its ringtones at
 * all.
 *
 * Both return an opaque handle: a content:// URI on Android, a filename on
 * iOS. Neither is meaningful to the other, and neither is a URL — they are
 * stored as `device:<handle>` and only ever handed back to the OS.
 */

export interface PickedSound {
  cancelled: boolean;
  /** Opaque to everything but the platform that produced it. */
  uri?: string;
  /** What to show the user. */
  name?: string;
}

interface DeviceSoundsPlugin {
  pickRingtone(options: { type?: string; title?: string; current?: string }): Promise<PickedSound>;
  pickAudioFile(): Promise<PickedSound>;
  preview(options: { uri: string }): Promise<void>;
  stopPreview(): Promise<void>;
  check(options: { uri: string }): Promise<{ ok: boolean }>;
}

let cached: DeviceSoundsPlugin | null | undefined;

async function plugin(): Promise<DeviceSoundsPlugin | null> {
  if (cached !== undefined) return cached;
  if (!isNative()) {
    cached = null;
    return null;
  }
  try {
    const { registerPlugin } = await import('@capacitor/core');
    cached = registerPlugin<DeviceSoundsPlugin>('DeviceSounds');
  } catch {
    cached = null;
  }
  return cached;
}

/** Can this build offer the phone's own sounds at all? */
export const deviceSoundsAvailable = () => isNative();

/**
 * What the button should say.
 *
 * Android really does open the ringtone list; iOS opens Files. Promising
 * "ringtones" on iOS would be a promise the platform does not keep.
 */
export const deviceSoundKind = (): 'ringtones' | 'files' | 'none' => {
  if (!isNative()) return 'none';
  return isAndroid() ? 'ringtones' : 'files';
};

/** Open the phone's own sound picker. */
export async function pickDeviceSound(current?: string | null): Promise<PickedSound> {
  const api = await plugin();
  if (!api) return { cancelled: true };
  const existing = current?.startsWith(DEVICE_PREFIX) ? current.slice(DEVICE_PREFIX.length) : undefined;
  try {
    return await api.pickRingtone({ type: 'alarm', current: existing });
  } catch {
    return { cancelled: true };
  }
}

/** Pick any audio file on the phone, rather than a ringtone. */
export async function pickDeviceAudioFile(): Promise<PickedSound> {
  const api = await plugin();
  if (!api) return { cancelled: true };
  try {
    return await api.pickAudioFile();
  } catch {
    return { cancelled: true };
  }
}

/** The sound id to store for a picked sound. */
export const deviceSoundId = (uri: string) => `${DEVICE_PREFIX}${uri}`;

export const isDeviceSound = (soundId: string | null | undefined): boolean =>
  Boolean(soundId?.startsWith(DEVICE_PREFIX));

/** Hear it before committing to it. */
export async function previewDeviceSound(soundId: string): Promise<boolean> {
  const api = await plugin();
  if (!api) return false;
  try {
    await api.preview({ uri: soundId.replace(DEVICE_PREFIX, '') });
    return true;
  } catch {
    return false;
  }
}

export async function stopDeviceSoundPreview(): Promise<void> {
  const api = await plugin();
  await api?.stopPreview().catch(() => undefined);
}

/**
 * Is the chosen sound still there?
 *
 * A file can be deleted, or a permission revoked, long after it was picked.
 * Finding that out when the alarm fails to ring is finding out too late, so
 * the settings screen checks and says so.
 */
export async function deviceSoundStillWorks(soundId: string): Promise<boolean> {
  const api = await plugin();
  if (!api) return false;
  try {
    const result = await api.check({ uri: soundId.replace(DEVICE_PREFIX, '') });
    return result.ok;
  } catch {
    return false;
  }
}
