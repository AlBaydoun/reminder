import { useSyncExternalStore } from 'react';

/**
 * One clock for the whole app.
 *
 * Dozens of countdowns tick at once, and giving each its own interval would
 * mean dozens of timers all firing at slightly different moments — jittery
 * digits and wasted battery. Everything subscribes to a single tick instead,
 * and each component asks for the resolution it actually needs: a countdown
 * showing seconds re-renders every second, one showing hours re-renders every
 * minute, and nothing re-renders in between.
 */

const subscribers = new Set<() => void>();
let timer: number | undefined;
let intervalMs = 1000;

function notify() {
  for (const fn of subscribers) fn();
}

function startTimer(period: number) {
  if (timer !== undefined) window.clearInterval(timer);
  intervalMs = period;
  timer = window.setInterval(notify, period);
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    // Catch up immediately: a hidden tab's timers are throttled hard, so the
    // numbers on screen are stale the moment it comes back.
    startTimer(1000);
    notify();
  } else {
    // Nobody is reading the digits; a slow tick is enough to stay roughly current.
    startTimer(15_000);
  }
}

function subscribe(callback: () => void): () => void {
  if (!subscribers.size) {
    startTimer(document.visibilityState === 'visible' ? 1000 : 15_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  subscribers.add(callback);

  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

/**
 * Current time, rounded down to `resolutionMs`.
 *
 * Rounding is what makes this cheap: the value only changes when the component
 * would actually display something different, so a row counting down in hours
 * does not re-render 3,600 times an hour.
 */
export function useNow(resolutionMs = 1000): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / resolutionMs) * resolutionMs,
    () => Math.floor(Date.now() / resolutionMs) * resolutionMs,
  );
}

/** How often a countdown to `target` needs to redraw to look alive. */
export function resolutionFor(target: number, now = Date.now()): number {
  const remaining = Math.abs(target - now);
  if (remaining < 60 * 60_000) return 1000; // seconds are visible
  if (remaining < 48 * 60 * 60_000) return 60_000; // minutes are visible
  return 5 * 60_000;
}
