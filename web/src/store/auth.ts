import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import type { User, UserSettings } from '../lib/types';
import { useUi } from './ui';

interface AuthState {
  user: User | null;
  status: 'unknown' | 'signed-out' | 'signed-in';
  busy: boolean;
  error: string | null;

  bootstrap(): Promise<void>;
  signIn(email: string, password: string): Promise<boolean>;
  signUp(email: string, password: string, name: string): Promise<boolean>;
  signOut(): Promise<void>;
  saveSettings(patch: Partial<UserSettings>): Promise<void>;
  saveProfile(patch: { name?: string; locale?: string; timezone?: string }): Promise<void>;
  clearError(): void;
}

const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Push the account's saved preferences into the UI layer after sign-in. */
function applyUserPreferences(user: User) {
  const ui = useUi.getState();
  if (user.locale && user.locale !== ui.locale) ui.setLocale(user.locale);
  if (user.settings.theme && user.settings.theme !== ui.theme) ui.setTheme(user.settings.theme);
  if (user.settings.motion && user.settings.motion !== ui.motion) ui.setMotion(user.settings.motion);
  if (user.settings.interfaceFont && user.settings.interfaceFont !== ui.interfaceFont) {
    ui.setInterfaceFont(user.settings.interfaceFont);
  }
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  status: 'unknown',
  busy: false,
  error: null,

  async bootstrap() {
    const user = await api.restoreSession();
    if (user) {
      applyUserPreferences(user);
      // A device that moved timezone should re-arm its alarms in the new one.
      const tz = browserTimezone();
      if (tz && tz !== user.timezone) {
        try {
          const updated = await api.updateProfile({ timezone: tz });
          await api.resyncReminders();
          set({ user: updated, status: 'signed-in' });
          return;
        } catch {
          /* keep the stored zone if the update fails */
        }
      }
      set({ user, status: 'signed-in' });
    } else {
      set({ user: null, status: 'signed-out' });
    }
  },

  async signIn(email, password) {
    set({ busy: true, error: null });
    try {
      const user = await api.login({ email, password });
      applyUserPreferences(user);
      set({ user, status: 'signed-in', busy: false });
      return true;
    } catch (err) {
      set({
        busy: false,
        error: err instanceof ApiError ? err.message : useUi.getState().t('error.generic'),
      });
      return false;
    }
  },

  async signUp(email, password, name) {
    set({ busy: true, error: null });
    try {
      const user = await api.signup({
        email,
        password,
        name,
        locale: useUi.getState().locale,
        timezone: browserTimezone(),
      });
      set({ user, status: 'signed-in', busy: false });
      return true;
    } catch (err) {
      set({
        busy: false,
        error: err instanceof ApiError ? err.message : useUi.getState().t('error.generic'),
      });
      return false;
    }
  },

  async signOut() {
    await api.logout();
    set({ user: null, status: 'signed-out' });
  },

  async saveSettings(patch) {
    const current = get().user;
    if (!current) return;
    // Update locally first so toggles feel instant; the server is authoritative
    // and its response replaces this optimistic value.
    set({ user: { ...current, settings: { ...current.settings, ...patch } } });
    try {
      const user = await api.updateProfile({ settings: patch });
      set({ user });
    } catch {
      set({ user: current });
      useUi.getState().toast(useUi.getState().t('error.generic'), 'error');
    }
  },

  async saveProfile(patch) {
    try {
      const user = await api.updateProfile(patch);
      set({ user });
      if (patch.timezone) await api.resyncReminders();
    } catch {
      useUi.getState().toast(useUi.getState().t('error.generic'), 'error');
    }
  },

  clearError() {
    set({ error: null });
  },
}));
