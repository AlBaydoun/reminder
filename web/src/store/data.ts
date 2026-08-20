import { create } from 'zustand';
import { api } from '../lib/api';
import type {
  BuiltinSound,
  CustomSound,
  Drawing,
  Item,
  Overview,
  Reminder,
} from '../lib/types';
import { useUi } from './ui';

export interface TreeNode {
  item: Item;
  children: TreeNode[];
  depth: number;
  /** Derived: a node with children reads as a category, a leaf as a task. */
  isCategory: boolean;
  totalDescendants: number;
  doneDescendants: number;
}

interface DataState {
  items: Item[];
  reminders: Reminder[];
  drawings: Drawing[];
  builtinSounds: BuiltinSound[];
  customSounds: CustomSound[];
  overview: Overview | null;
  loading: boolean;
  loaded: boolean;
  lastError: string | null;

  refresh(options?: { silent?: boolean }): Promise<void>;
  refreshOverview(): Promise<void>;
  refreshSounds(): Promise<void>;
  refreshDrawings(itemId?: string): Promise<void>;

  createItem(input: Partial<Item> & { title: string }): Promise<Item | null>;
  updateItem(id: string, patch: Partial<Item>): Promise<void>;
  toggleComplete(id: string, done?: boolean, cascade?: boolean): Promise<void>;
  moveItem(id: string, parentId: string | null): Promise<void>;
  deleteItem(id: string): Promise<void>;
  restoreItem(id: string): Promise<void>;
  purgeItem(id: string): Promise<void>;

  createReminder(input: Partial<Reminder> & { itemId: string; fireAt: string }): Promise<Reminder | null>;
  updateReminder(id: string, patch: Partial<Reminder>): Promise<void>;
  deleteReminder(id: string): Promise<void>;
}

export const useData = create<DataState>((set, get) => ({
  items: [],
  reminders: [],
  drawings: [],
  builtinSounds: [],
  customSounds: [],
  overview: null,
  loading: false,
  loaded: false,
  lastError: null,

  async refresh(options = {}) {
    if (!options.silent) set({ loading: true });
    try {
      const [items, reminders] = await Promise.all([api.listItems(true), api.listReminders()]);
      set({ items: items.items, reminders, loading: false, loaded: true, lastError: null });
      void get().refreshOverview();
    } catch (err) {
      set({ loading: false, lastError: (err as Error).message });
      if (!options.silent) useUi.getState().toast(useUi.getState().t('error.offline'), 'error');
    }
  },

  async refreshOverview() {
    try {
      set({ overview: await api.overview() });
    } catch {
      /* the dashboard simply shows nothing rather than blocking the app */
    }
  },

  async refreshSounds() {
    try {
      const { builtin, custom } = await api.listSounds();
      set({ builtinSounds: builtin, customSounds: custom });
    } catch {
      /* keep whatever we already had */
    }
  },

  async refreshDrawings(itemId) {
    try {
      set({ drawings: await api.listDrawings(itemId) });
    } catch {
      /* non-fatal */
    }
  },

  async createItem(input) {
    try {
      const item = await api.createItem(input as any);
      set((state) => ({ items: [...state.items, item] }));
      void get().refreshOverview();
      return item;
    } catch (err) {
      useUi.getState().toast((err as Error).message, 'error');
      return null;
    }
  },

  async updateItem(id, patch) {
    const previous = get().items;
    // Optimistic: the edit shows immediately, and is rolled back if it fails.
    set({ items: previous.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
    try {
      const item = await api.updateItem(id, patch);
      set((state) => ({ items: state.items.map((i) => (i.id === id ? item : i)) }));
      void get().refreshOverview();
    } catch (err) {
      set({ items: previous });
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async toggleComplete(id, done = true, cascade = false) {
    const previous = get().items;
    const now = new Date().toISOString();
    set({
      items: previous.map((i) =>
        i.id === id || (cascade && isDescendant(previous, i.id, id))
          ? { ...i, status: done ? 'done' : 'open', completedAt: done ? now : null }
          : i,
      ),
    });
    try {
      const result = await api.completeItem(id, done, cascade);
      if (result.rolledForwardTo) {
        const ui = useUi.getState();
        ui.toast(
          ui.t('item.completed') + ' → ' + new Date(result.rolledForwardTo).toLocaleString(),
          'success',
        );
      }
      await get().refresh({ silent: true });
    } catch (err) {
      set({ items: previous });
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async moveItem(id, parentId) {
    const previous = get().items;
    set({ items: previous.map((i) => (i.id === id ? { ...i, parentId } : i)) });
    try {
      const item = await api.moveItem(id, parentId);
      set((state) => ({ items: state.items.map((i) => (i.id === id ? item : i)) }));
    } catch (err) {
      set({ items: previous });
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async deleteItem(id) {
    const previous = get().items;
    const ts = new Date().toISOString();
    const affected = new Set([id, ...descendantIds(previous, id)]);
    set({ items: previous.map((i) => (affected.has(i.id) ? { ...i, deletedAt: ts } : i)) });
    try {
      await api.deleteItem(id);
      void get().refreshOverview();
    } catch (err) {
      set({ items: previous });
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async restoreItem(id) {
    try {
      await api.restoreItem(id);
      await get().refresh({ silent: true });
    } catch (err) {
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async purgeItem(id) {
    try {
      await api.deleteItem(id, true);
      await get().refresh({ silent: true });
    } catch (err) {
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async createReminder(input) {
    try {
      const reminder = await api.createReminder(input);
      set((state) => ({ reminders: [...state.reminders, reminder] }));
      return reminder;
    } catch (err) {
      useUi.getState().toast((err as Error).message, 'error');
      return null;
    }
  },

  async updateReminder(id, patch) {
    try {
      const reminder = await api.updateReminder(id, patch);
      set((state) => ({ reminders: state.reminders.map((r) => (r.id === id ? reminder : r)) }));
    } catch (err) {
      useUi.getState().toast((err as Error).message, 'error');
    }
  },

  async deleteReminder(id) {
    const previous = get().reminders;
    set({ reminders: previous.filter((r) => r.id !== id) });
    try {
      await api.deleteReminder(id);
    } catch (err) {
      set({ reminders: previous });
      useUi.getState().toast((err as Error).message, 'error');
    }
  },
}));

// ── Derived helpers ────────────────────────────────────────────────────────

export function descendantIds(items: Item[], rootId: string): string[] {
  const byParent = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
  }
  const out: string[] = [];
  const queue = [...(byParent.get(rootId) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    out.push(next.id);
    queue.push(...(byParent.get(next.id) ?? []));
  }
  return out;
}

function isDescendant(items: Item[], candidateId: string, rootId: string): boolean {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cursor = byId.get(candidateId);
  let guard = 0;
  while (cursor?.parentId && guard++ < 64) {
    if (cursor.parentId === rootId) return true;
    cursor = byId.get(cursor.parentId);
  }
  return false;
}

/** Build the visible tree (deleted rows excluded) with roll-up counts. */
export function buildTree(items: Item[], options: { includeDone?: boolean } = {}): TreeNode[] {
  const live = items.filter((i) => !i.deletedAt && (options.includeDone !== false || i.status !== 'done'));
  const byParent = new Map<string | null, Item[]>();
  for (const item of live) {
    const key = item.parentId && live.some((i) => i.id === item.parentId) ? item.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), item]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title));
  }

  const build = (parentId: string | null, depth: number): TreeNode[] =>
    (byParent.get(parentId) ?? []).map((item) => {
      const children = build(item.id, depth + 1);
      const totalDescendants = children.reduce((n, c) => n + 1 + c.totalDescendants, 0);
      const doneDescendants = children.reduce(
        (n, c) => n + (c.item.status === 'done' ? 1 : 0) + c.doneDescendants,
        0,
      );
      return {
        item,
        children,
        depth,
        isCategory: children.length > 0,
        totalDescendants,
        doneDescendants,
      };
    });

  return build(null, 0);
}

export function flattenTree(nodes: TreeNode[], collapsed?: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (!collapsed?.has(node.item.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.item.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

export function itemPath(items: Item[], id: string): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: Item[] = [];
  let cursor = byId.get(id);
  let guard = 0;
  while (cursor && guard++ < 32) {
    out.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return out;
}
