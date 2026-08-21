import {
  initNative,
  isAndroid,
  isIOS,
  isNative,
  loadHaptics,
  loadSplashScreen,
  loadStatusBar,
} from './bridge';

/**
 * The things that make a web app stop feeling like a web page in a box.
 *
 * None of it changes what the app does. All of it changes whether it feels
 * like it belongs on the phone: the status bar matching the interface instead
 * of sitting on top of it, the notch not covering the first row, a real tap
 * you can feel, and the launch image handing over once there is something to
 * look at rather than after a fixed delay.
 */

/** Called once, after the first render, so the splash hides on real content. */
export async function initNativeShell(theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await initNative();
  if (!isNative()) return;

  applySafeAreaInsets();
  await applyStatusBar(theme);

  const SplashScreen = await loadSplashScreen();
  // Hidden here rather than on a timer: a splash that outlasts the app being
  // ready is a stall, and one that leaves early is a white flash.
  await SplashScreen?.hide().catch(() => undefined);
}

/**
 * Match the status bar to the interface.
 *
 * `Style.Dark` means *light text*, which reads backwards until you remember it
 * describes the background it is meant to sit on.
 */
export async function applyStatusBar(theme: 'dark' | 'light'): Promise<void> {
  const bar = await loadStatusBar();
  if (!bar) return;
  try {
    await bar.StatusBar.setStyle({ style: theme === 'dark' ? bar.Style.Dark : bar.Style.Light });
    if (isAndroid()) {
      await bar.StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#070711' : '#f4f5fb' });
    }
  } catch {
    /* not fatal — the app is perfectly usable with the default bar */
  }
}

/**
 * Give CSS the notch measurements.
 *
 * `env(safe-area-inset-*)` already works inside the WebView, so this exists to
 * expose the same numbers as plain custom properties, letting the existing
 * stylesheet use one spelling for both web and phone.
 */
function applySafeAreaInsets(): void {
  const root = document.documentElement;
  root.classList.add('is-native', isIOS() ? 'is-ios' : 'is-android');
  root.style.setProperty('--safe-top', 'env(safe-area-inset-top, 0px)');
  root.style.setProperty('--safe-bottom', 'env(safe-area-inset-bottom, 0px)');
  root.style.setProperty('--safe-left', 'env(safe-area-inset-left, 0px)');
  root.style.setProperty('--safe-right', 'env(safe-area-inset-right, 0px)');
}

export type HapticWeight = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

/**
 * A real tap.
 *
 * `navigator.vibrate` is a blunt buzz and does not exist on iOS at all. The
 * native haptic engine has weights, which is the difference between an
 * interface that feels responsive and one that feels like a phone rattling.
 */
export async function haptic(weight: HapticWeight = 'light'): Promise<void> {
  const mod = await loadHaptics();
  if (!mod) return;
  try {
    if (weight === 'success' || weight === 'warning' || weight === 'error') {
      const type =
        weight === 'success'
          ? mod.NotificationType.Success
          : weight === 'warning'
            ? mod.NotificationType.Warning
            : mod.NotificationType.Error;
      await mod.Haptics.notification({ type });
      return;
    }
    const style =
      weight === 'heavy' ? mod.ImpactStyle.Heavy : weight === 'medium' ? mod.ImpactStyle.Medium : mod.ImpactStyle.Light;
    await mod.Haptics.impact({ style });
  } catch {
    /* a phone with no haptic engine — silence is the right fallback */
  }
}

/** Selection feedback: the small click as a value changes under a finger. */
export async function hapticSelection(): Promise<void> {
  const mod = await loadHaptics();
  try {
    await mod?.Haptics.selectionChanged();
  } catch {
    /* ignored */
  }
}
