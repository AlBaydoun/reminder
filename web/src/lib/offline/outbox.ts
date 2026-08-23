/**
 * Changes made with no connection, waiting their turn.
 *
 * The hard part is not the queue. It is that something created offline has no
 * real id yet: a task made on a plane gets a temporary one, and everything
 * done to it afterwards — renaming it, giving it an alarm, putting a subtask
 * under it — refers to that temporary id. When the server finally issues the
 * real one, every reference still queued behind it has to be rewritten, or the
 * replay sends edits for a task that does not exist.
 *
 * So this file owns two things: an ordered, durable list of operations, and
 * the mapping from temporary ids to real ones.
 */

const STORAGE_KEY = 'nexus.outbox';

/** Only what can honestly be done without a server. */
export type OutboxKind =
  | 'createItem'
  | 'updateItem'
  | 'completeItem'
  | 'moveItem'
  | 'deleteItem'
  | 'restoreItem'
  | 'reorderItems'
  | 'createReminder'
  | 'updateReminder'
  | 'deleteReminder'
  | 'snoozeReminder'
  | 'dismissReminder'
  | 'createDrawing'
  | 'updateDrawing'
  | 'deleteDrawing';

export interface OutboxOp {
  /** Ordering and de-duplication. */
  id: string;
  kind: OutboxKind;
  /** Serialisable call arguments, in the order the api method takes them. */
  args: unknown[];
  /** The temporary id this operation *created*, if it created something. */
  creates?: string;
  at: string;
  /** How many times replay has been attempted, so a poison op cannot loop. */
  attempts: number;
}

/** The prefix that marks an id as not yet real. */
export const TEMP_PREFIX = 'local:';

export const isTempId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(TEMP_PREFIX);

export const newTempId = (): string =>
  `${TEMP_PREFIX}${
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }`;

interface Persisted {
  ops: OutboxOp[];
  /** temporary id → the real id the server gave it. */
  resolved: Record<string, string>;
}

export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): OutboxStorage {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem(STORAGE_KEY);
      return localStorage;
    }
  } catch {
    /* fall through */
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
  };
}

let storage: OutboxStorage = defaultStorage();
let state: Persisted | null = null;

/** Point the outbox at different storage. Used by the tests. */
export function useOutboxStorage(next: OutboxStorage) {
  storage = next;
  state = null;
}

function load(): Persisted {
  if (state) return state;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Persisted) : null;
    state = parsed?.ops ? { ops: parsed.ops, resolved: parsed.resolved ?? {} } : { ops: [], resolved: {} };
  } catch {
    state = { ops: [], resolved: {} };
  }
  return state;
}

function save() {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch {
    /* the queue still holds for this run */
  }
}

export const pendingOps = (): OutboxOp[] => [...load().ops];
export const pendingCount = (): number => load().ops.length;

export function enqueue(kind: OutboxKind, args: unknown[], creates?: string): OutboxOp {
  const current = load();
  const op: OutboxOp = {
    id: `${Date.now().toString(36)}-${current.ops.length}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    args,
    creates,
    at: new Date().toISOString(),
    attempts: 0,
  };
  current.ops.push(op);
  save();
  return op;
}

export function removeOp(id: string) {
  const current = load();
  current.ops = current.ops.filter((op) => op.id !== id);
  save();
}

export function noteAttempt(id: string) {
  const op = load().ops.find((o) => o.id === id);
  if (op) {
    op.attempts++;
    save();
  }
}

/**
 * Remember that a temporary id is now a real one.
 *
 * The mapping outlives the queue on purpose: a task created offline can be
 * referenced by something enqueued much later, and by the interface, long
 * after the operation that created it has been replayed and dropped.
 */
export function resolveTempId(tempId: string, realId: string) {
  const current = load();
  current.resolved[tempId] = realId;
  save();
}

export const realIdFor = (tempId: string): string | undefined => load().resolved[tempId];

/**
 * Rewrite every temporary id inside a value to the real one.
 *
 * Deep because ids hide in nested places — a reminder's `itemId`, an item's
 * `parentId`, the array handed to a reorder. Anything still unresolved is left
 * exactly as it was, which is what lets an operation be recognised as not yet
 * replayable rather than silently sent with a broken reference.
 */
export function substituteIds<T>(value: T, resolved: Record<string, string> = load().resolved): T {
  if (typeof value === 'string') return (resolved[value] ?? value) as T;
  if (Array.isArray(value)) return value.map((entry) => substituteIds(entry, resolved)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteIds(entry, resolved);
    }
    return out as T;
  }
  return value;
}

/** Does this operation still refer to something that has no real id yet? */
export function hasUnresolvedIds(value: unknown, resolved: Record<string, string> = load().resolved): boolean {
  if (typeof value === 'string') return isTempId(value) && resolved[value] === undefined;
  if (Array.isArray(value)) return value.some((entry) => hasUnresolvedIds(entry, resolved));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => hasUnresolvedIds(entry, resolved));
  }
  return false;
}

export const resolvedMap = (): Record<string, string> => ({ ...load().resolved });

export function clearOutbox() {
  state = { ops: [], resolved: {} };
  save();
}
