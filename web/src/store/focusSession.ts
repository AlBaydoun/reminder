import { create } from 'zustand';
import { playSound, unlockAudio, vibrate } from '../lib/audio/player';
import { useUi } from './ui';

const STORAGE_KEY = 'nexus.focusSession';

interface Persisted {
  itemId: string;
  totalMs: number;
  accumulatedMs: number;
  startedAt: number | null;
  finished: boolean;
}

interface FocusSessionState {
  itemId: string | null;
  totalMs: number;
  /** Time counted before the current run; a pause banks into this. */
  accumulatedMs: number;
  /** Wall-clock start of the current run, or null while paused. */
  startedAt: number | null;
  finished: boolean;

  start(itemId: string, minutes: number): void;
  pause(): void;
  resume(): void;
  extend(minutes: number): void;
  stop(): void;
  markFinished(title: string): void;
  elapsed(now?: number): number;
}

function persist(state: FocusSessionState) {
  try {
    if (!state.itemId) localStorage.removeItem(STORAGE_KEY);
    else {
      const payload: Persisted = {
        itemId: state.itemId,
        totalMs: state.totalMs,
        accumulatedMs: state.accumulatedMs,
        startedAt: state.startedAt,
        finished: state.finished,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    /* private mode — the session still runs, it just will not survive a reload */
  }
}

function restore(): Partial<FocusSessionState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Persisted;
    if (!saved?.itemId) return {};
    // Elapsed time is derived from the wall clock, so a session that was
    // running when the tab closed has kept running in the meantime — which is
    // what a person would expect of a timer.
    return {
      itemId: saved.itemId,
      totalMs: saved.totalMs,
      accumulatedMs: saved.accumulatedMs,
      startedAt: saved.startedAt,
      finished: saved.finished,
    };
  } catch {
    return {};
  }
}

/** A system notification for the end of a session, if one is allowed. */
function notifyComplete(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const options: NotificationOptions = {
    body,
    tag: 'nexus-focus-session',
    icon: `${import.meta.env.BASE_URL}icon-192.png`,
    badge: `${import.meta.env.BASE_URL}icon-192.png`,
  };
  void navigator.serviceWorker?.ready
    .then((registration) => registration.showNotification(title, options))
    .catch(() => {
      new Notification(title, options);
    });
}

export const useFocusSession = create<FocusSessionState>((set, get) => ({
  itemId: null,
  totalMs: 25 * 60_000,
  accumulatedMs: 0,
  startedAt: null,
  finished: false,
  ...restore(),

  start(itemId, minutes) {
    void unlockAudio();
    set({
      itemId,
      totalMs: Math.max(1, minutes) * 60_000,
      accumulatedMs: 0,
      startedAt: Date.now(),
      finished: false,
    });
    persist(get());
  },

  pause() {
    const { startedAt, accumulatedMs } = get();
    if (startedAt === null) return;
    set({ accumulatedMs: accumulatedMs + (Date.now() - startedAt), startedAt: null });
    persist(get());
  },

  resume() {
    if (get().startedAt !== null) return;
    set({ startedAt: Date.now(), finished: false });
    persist(get());
  },

  extend(minutes) {
    set((state) => ({
      totalMs: state.totalMs + minutes * 60_000,
      finished: false,
      // Extending resumes: nobody adds five minutes in order to stay stopped.
      startedAt: state.startedAt ?? Date.now(),
    }));
    persist(get());
  },

  stop() {
    set({ itemId: null, accumulatedMs: 0, startedAt: null, finished: false });
    persist(get());
  },

  markFinished(title) {
    if (get().finished) return;
    set({ finished: true });
    persist(get());

    const ui = useUi.getState();
    playSound('builtin:harp', { volume: 0.85, loop: false });
    vibrate([300, 120, 300]);
    notifyComplete(ui.t('focusSession.complete'), ui.t('focusSession.completeBody', { title }));
    ui.toast(ui.t('focusSession.complete'), 'success');
  },

  elapsed(now = Date.now()) {
    const { accumulatedMs, startedAt } = get();
    return accumulatedMs + (startedAt === null ? 0 : now - startedAt);
  },
}));

export const SESSION_LENGTHS = [10, 15, 25, 45, 60, 90];
