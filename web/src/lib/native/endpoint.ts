/**
 * Where the server lives.
 *
 * On the web the app and the API share an origin, so every request is just
 * `/api/...` and the browser handles the refresh cookie. Inside a native shell
 * there is no such luck: the page is served from `capacitor://localhost`, so a
 * bare `/api` would resolve to the app bundle itself. The phone build has to be
 * told which server to talk to, and the answer has to survive a restart.
 */

const STORAGE_KEY = 'nexus.serverUrl';

/** A URL baked in at build time, for a team shipping to its own server. */
const BUILT_IN = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ?? '';

let current: string | null = null;
const listeners = new Set<(base: string) => void>();

function read(): string {
  if (current !== null) return current;
  try {
    current = localStorage.getItem(STORAGE_KEY) ?? BUILT_IN;
  } catch {
    current = BUILT_IN;
  }
  return current;
}

/**
 * The origin of the API, or '' when it is the page's own origin.
 *
 * Empty is the right answer for the web build and the demo, and it is what
 * keeps `credentials: 'same-origin'` working there.
 */
export function apiOrigin(): string {
  return read();
}

/** The full URL for an API path. */
export function apiUrl(path: string): string {
  const origin = read();
  return origin ? `${origin}/api${path}` : `/api${path}`;
}

/**
 * Cross-origin requests need `include` or the refresh cookie is dropped, but
 * asking for `include` on a same-origin request would be a needless
 * relaxation, so this follows whichever case is actually in play.
 */
export function credentialsMode(): RequestCredentials {
  return read() ? 'include' : 'same-origin';
}

/** Point the app at a different server. Persisted, and takes effect at once. */
export function setApiOrigin(url: string) {
  const cleaned = url.trim().replace(/\/+$/, '');
  current = cleaned;
  try {
    if (cleaned) localStorage.setItem(STORAGE_KEY, cleaned);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode — it holds for this run and is asked for again next time */
  }
  for (const fn of listeners) fn(cleaned);
}

export function onApiOriginChange(fn: (base: string) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is this server reachable and actually a Nexus server? */
export async function probeServer(url: string): Promise<{ ok: boolean; detail: string }> {
  const cleaned = url.trim().replace(/\/+$/, '');
  if (!cleaned) return { ok: false, detail: 'empty' };
  try {
    const res = await fetch(`${cleaned}/api/health`, { method: 'GET' });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean; serverTime?: string };
    // A generic 200 from some other service is not a Nexus server; the health
    // route's shape is what distinguishes them.
    if (!data?.ok || !data.serverTime) return { ok: false, detail: 'not a Nexus server' };
    return { ok: true, detail: data.serverTime };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
