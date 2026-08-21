/**
 * The line between the web app and the phone.
 *
 * Everything native is reached through this file, for two reasons. The web
 * build must not pull Capacitor into its bundle, and the rest of the app must
 * not be littered with `if (native)`. So each capability is a plain async
 * function with a web answer and a phone answer, and callers just call it.
 *
 * The imports are dynamic on purpose: `@capacitor/core` and friends are only
 * fetched when the app is actually running inside a shell, so the browser
 * build never downloads code it cannot use.
 */

export type NativePlatform = 'web' | 'ios' | 'android';

/**
 * Built as a phone app, rather than *running* as one. The distinction matters
 * during development, when the native bundle is often opened in a browser.
 */
export const IS_NATIVE_BUILD = import.meta.env.VITE_NATIVE === 'true';

let platform: NativePlatform = 'web';
let ready = false;
let readyPromise: Promise<void> | null = null;

type CapacitorCore = typeof import('@capacitor/core');
let core: CapacitorCore | null = null;

/**
 * Resolve which platform this really is.
 *
 * Called once at startup. Everything else assumes it has run, which is why the
 * promise is cached rather than the work repeated.
 */
export function initNative(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!IS_NATIVE_BUILD) {
      ready = true;
      return;
    }
    try {
      core = await import('@capacitor/core');
      platform = core.Capacitor.getPlatform() as NativePlatform;
      // A native *build* opened in a desktop browser reports 'web', and that
      // is the honest answer — none of the plugins are there.
      if (!core.Capacitor.isNativePlatform()) platform = 'web';
    } catch {
      platform = 'web';
    }
    ready = true;
  })();
  return readyPromise;
}

export const nativePlatform = (): NativePlatform => platform;
export const isNative = (): boolean => ready && platform !== 'web';
export const isIOS = (): boolean => platform === 'ios';
export const isAndroid = (): boolean => platform === 'android';

/** Is this plugin actually present? Guards every call below. */
async function plugin<T>(name: string, load: () => Promise<T>): Promise<T | null> {
  if (!isNative()) return null;
  try {
    if (core && !core.Capacitor.isPluginAvailable(name)) return null;
    return await load();
  } catch {
    return null;
  }
}

export const loadLocalNotifications = () =>
  plugin('LocalNotifications', async () => (await import('@capacitor/local-notifications')).LocalNotifications);

export const loadHaptics = () =>
  plugin('Haptics', async () => await import('@capacitor/haptics'));

export const loadApp = () => plugin('App', async () => (await import('@capacitor/app')).App);

export const loadStatusBar = () =>
  plugin('StatusBar', async () => await import('@capacitor/status-bar'));

export const loadSplashScreen = () =>
  plugin('SplashScreen', async () => (await import('@capacitor/splash-screen')).SplashScreen);

export const loadPreferences = () =>
  plugin('Preferences', async () => (await import('@capacitor/preferences')).Preferences);

export const loadFilesystem = () =>
  plugin('Filesystem', async () => await import('@capacitor/filesystem'));
