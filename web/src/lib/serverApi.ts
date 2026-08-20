import type {
  BackupRecord,
  BatchOp,
  BuiltinSound,
  CanvasText,
  CategorySuggestion,
  CustomSound,
  DayLoad,
  Drawing,
  DueReminder,
  DuplicateGroup,
  Item,
  Overview,
  Reminder,
  ScoredItem,
  Stroke,
  User,
  UserSettings,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The access token lives in memory only. The long-lived refresh token is an
 * httpOnly cookie the browser handles, so a cross-site script cannot read
 * either one out of storage.
 */
let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export function setAccessToken(token: string | null) {
  accessToken = token;
  for (const fn of listeners) fn(Boolean(token));
}
export const getAccessToken = () => accessToken;
export function onAuthChange(fn: (signedIn: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Exchange the refresh cookie for a new access token. Concurrent callers share one request. */
async function refresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) {
          setAccessToken(null);
          return false;
        }
        const data = (await res.json()) as { accessToken: string };
        setAccessToken(data.accessToken);
        return true;
      } catch {
        return false;
      } finally {
        // Clear on the next tick so callers awaiting this promise still see it.
        setTimeout(() => (refreshInFlight = null), 0);
      }
    })();
  }
  return refreshInFlight;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set by the retry path so a failed refresh cannot loop forever. */
  _retried?: boolean;
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, _retried, raw, headers, ...rest } = options;
  const isFormData = body instanceof FormData;

  const res = await fetch(`/api${path}`, {
    ...rest,
    credentials: 'same-origin',
    headers: {
      ...(isFormData || body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(headers as Record<string, string>),
    },
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  });

  if (res.status === 401 && !_retried && path !== '/auth/refresh' && path !== '/auth/login') {
    if (await refresh()) return request<T>(path, { ...options, _retried: true });
  }

  if (!res.ok) {
    let message = res.statusText || 'Request failed';
    let code = 'error';
    let details: unknown;
    try {
      const data = await res.json();
      message = data.error ?? message;
      code = data.code ?? code;
      details = data.details;
    } catch {
      /* a non-JSON error body is fine — keep the status text */
    }
    throw new ApiError(res.status, message, code, details);
  }

  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  // ── auth ────────────────────────────────────────────────────────────────
  async signup(input: { email: string; password: string; name?: string; locale?: string; timezone?: string }) {
    const data = await post<{ user: User; accessToken: string }>('/auth/signup', input);
    setAccessToken(data.accessToken);
    return data.user;
  },
  async login(input: { email: string; password: string }) {
    const data = await post<{ user: User; accessToken: string }>('/auth/login', input);
    setAccessToken(data.accessToken);
    return data.user;
  },
  async restoreSession(): Promise<User | null> {
    if (!(await refresh())) return null;
    try {
      const { user } = await get<{ user: User }>('/auth/me');
      return user;
    } catch {
      setAccessToken(null);
      return null;
    }
  },
  async logout() {
    try {
      await post('/auth/logout');
    } finally {
      setAccessToken(null);
    }
  },
  me: () => get<{ user: User }>('/auth/me').then((d) => d.user),
  updateProfile: (patchBody: { name?: string; locale?: string; timezone?: string; settings?: UserSettings }) =>
    patch<{ user: User }>('/auth/me', patchBody).then((d) => d.user),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: boolean; message: string }>('/auth/password', { currentPassword, newPassword }),

  // ── items ───────────────────────────────────────────────────────────────
  listItems: (includeDeleted = false) =>
    get<{ items: Item[]; counts: Record<string, { total: number; done: number }> }>(
      `/items?includeDeleted=${includeDeleted}`,
    ),
  getItem: (id: string) => get<{ item: Item; children: Item[]; path: string[] }>(`/items/${id}`),
  createItem: (input: Partial<Item> & { title: string; parentPath?: string[]; createMissingPath?: boolean }) =>
    post<{ item: Item }>('/items', input).then((d) => d.item),
  updateItem: (id: string, input: Partial<Item>) =>
    patch<{ item: Item }>(`/items/${id}`, input).then((d) => d.item),
  completeItem: (id: string, done = true, cascade = false) =>
    post<{ item: Item; affected?: string[]; rolledForwardTo?: string }>(`/items/${id}/complete`, { done, cascade }),
  moveItem: (id: string, parentId: string | null, position?: number) =>
    post<{ item: Item }>(`/items/${id}/move`, { parentId, position }).then((d) => d.item),
  reorderItems: (parentId: string | null, ids: string[]) => post('/items/reorder', { parentId, ids }),
  deleteItem: (id: string, hard = false) => del<{ ok: boolean; affected: string[] }>(`/items/${id}?hard=${hard}`),
  restoreItem: (id: string) => post<{ ok: boolean }>(`/items/${id}/restore`),

  // ── reminders ───────────────────────────────────────────────────────────
  listReminders: () => get<{ reminders: Reminder[] }>('/reminders').then((d) => d.reminders),
  dueReminders: (lookaheadMs = 0) =>
    get<{ due: DueReminder[]; serverTime: string }>(`/reminders/due?lookaheadMs=${lookaheadMs}`),
  upcomingReminders: (hours = 24) =>
    get<{ upcoming: DueReminder[]; serverTime: string }>(`/reminders/upcoming?hours=${hours}`),
  createReminder: (input: Partial<Reminder> & { itemId: string; fireAt: string }) =>
    post<{ reminder: Reminder }>('/reminders', input).then((d) => d.reminder),
  updateReminder: (id: string, input: Partial<Reminder>) =>
    patch<{ reminder: Reminder }>(`/reminders/${id}`, input).then((d) => d.reminder),
  markReminderFired: (id: string) => post<{ reminder: Reminder }>(`/reminders/${id}/fired`).then((d) => d.reminder),
  snoozeReminder: (id: string, minutes?: number) =>
    post<{ reminder: Reminder; snoozedUntil: string }>(`/reminders/${id}/snooze`, { minutes }),
  dismissReminder: (id: string) => post<{ reminder: Reminder }>(`/reminders/${id}/dismiss`).then((d) => d.reminder),
  deleteReminder: (id: string) => del<{ ok: boolean }>(`/reminders/${id}`),
  resyncReminders: () => post<{ ok: boolean; rescheduled: number }>('/reminders/resync'),

  // ── sounds ──────────────────────────────────────────────────────────────
  listSounds: () => get<{ builtin: BuiltinSound[]; custom: CustomSound[] }>('/sounds'),
  uploadSound: (file: File, name?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (name) form.append('name', name);
    return request<{ sound: CustomSound }>('/sounds', { method: 'POST', body: form }).then((d) => d.sound);
  },
  renameSound: (id: string, name: string) => patch<{ ok: boolean }>(`/sounds/${id}`, { name }),
  deleteSound: (id: string) => del<{ ok: boolean }>(`/sounds/${id}`),

  // ── drawings ────────────────────────────────────────────────────────────
  listDrawings: (itemId?: string) =>
    get<{ drawings: Drawing[] }>(`/drawings${itemId ? `?itemId=${itemId}` : ''}`).then((d) => d.drawings),
  createDrawing: (input: {
    itemId?: string | null;
    title?: string;
    strokes: Stroke[];
    texts?: CanvasText[];
    width: number;
    height: number;
    thumbnail?: string;
    recognizedText?: string;
  }) => post<{ drawing: Drawing }>('/drawings', input).then((d) => d.drawing),
  updateDrawing: (id: string, input: Partial<Drawing>) =>
    patch<{ drawing: Drawing }>(`/drawings/${id}`, input).then((d) => d.drawing),
  deleteDrawing: (id: string) => del<{ ok: boolean }>(`/drawings/${id}`),

  // ── reasoning ───────────────────────────────────────────────────────────
  overview: () => get<Overview>('/brain/overview'),
  focus: (limit = 20, includeBlocked = false) =>
    get<{ focus: ScoredItem[] }>(`/brain/focus?limit=${limit}&includeBlocked=${includeBlocked}`).then((d) => d.focus),
  forecast: (days = 14) => get<{ forecast: DayLoad[] }>(`/brain/forecast?days=${days}`).then((d) => d.forecast),
  duplicates: () => get<{ duplicates: DuplicateGroup[] }>('/brain/duplicates').then((d) => d.duplicates),
  categorize: (title: string) =>
    post<{ suggestions: CategorySuggestion[] }>('/brain/categorize', { title }).then((d) => d.suggestions),
  suggestSlots: (effortMinutes: number, days = 7) =>
    post<{ slots: Array<{ start: string; end: string; dayLoadMinutes: number; rank: number }> }>(
      '/brain/schedule',
      { effortMinutes, days },
    ).then((d) => d.slots),
  search: (q: string) =>
    get<{ results: Array<{ id: string; title: string; icon: string; color: string; parentId: string | null; status: string; dueAt: string | null; tags: string[]; snippet: string }> }>(
      `/brain/search?q=${encodeURIComponent(q)}`,
    ).then((d) => d.results),

  // ── voice batch ─────────────────────────────────────────────────────────
  runBatch: (ops: BatchOp[], transcript?: string) =>
    post<{ results: unknown[]; undoId: string; applied: number }>('/batch', { ops, transcript }),
  undoBatch: (undoId: string) => post<{ ok: boolean; reverted: number }>(`/batch/undo/${undoId}`),

  // ── backups ─────────────────────────────────────────────────────────────
  listBackups: () => get<{ backups: BackupRecord[]; lastNightly: string | null }>('/backups'),
  createBackup: () => post<{ backup: { id: string; filename: string; size: number } }>('/backups'),
  restoreBackup: (id: string, mode: 'replace' | 'merge' = 'replace') =>
    post<{ ok: boolean; restored: Record<string, number>; safetyBackup: string }>(`/backups/${id}/restore`, { mode }),
  deleteBackup: (id: string) => del<{ ok: boolean }>(`/backups/${id}`),
  runNightlyBackup: () => post<{ ok: boolean; users: number; removed: number }>('/backups/run-nightly'),
  importBackup: (file: File, mode: 'replace' | 'merge' = 'replace') => {
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    return request<{ ok: boolean; restored: Record<string, number> }>('/backups/import', {
      method: 'POST',
      body: form,
    });
  },
  exportUrl: () => '/api/backups/export',
  backupDownloadUrl: (id: string) => `/api/backups/${id}/download`,

  health: () => get<{ ok: boolean; serverTime: string; timezone: string }>('/health'),
};
