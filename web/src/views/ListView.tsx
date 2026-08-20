import { AnimatePresence } from 'framer-motion';
import { FolderTree, ListFilter } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ItemRow } from '../components/ItemRow';
import { QuickAdd } from '../components/QuickAdd';
import { EmptyState, Segmented } from '../components/ui';
import { buildTree, flattenTree, inkThumbnails, useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

type Filter = 'open' | 'all' | 'done';

const COLLAPSE_KEY = 'nexus.collapsed';

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * The full tree. Every row is both a category and a task; adding a child to a
 * leaf turns it into a category without any conversion step.
 */
export function ListView() {
  const { dict } = useTranslation();
  const items = useData((s) => s.items);
  const reminders = useData((s) => s.reminders);
  const drawings = useData((s) => s.drawings);
  const toggleComplete = useData((s) => s.toggleComplete);
  const moveItem = useData((s) => s.moveItem);
  const openDetail = useUi((s) => s.openDetail);

  const [filter, setFilter] = useState<Filter>('open');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);

  const persistCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
  };

  const toggleCollapse = useCallback(
    (id: string) => {
      const next = new Set(collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistCollapsed(next);
    },
    [collapsed],
  );

  const ink = useMemo(() => inkThumbnails(drawings), [drawings]);

  const remindersByItem = useMemo(() => {
    const map = new Map<string, typeof reminders>();
    for (const reminder of reminders) {
      map.set(reminder.itemId, [...(map.get(reminder.itemId) ?? []), reminder]);
    }
    return map;
  }, [reminders]);

  const blockedIds = useMemo(() => {
    const statusById = new Map(items.map((i) => [i.id, i.status]));
    return new Set(
      items
        .filter((i) => i.blockedBy.some((dep) => statusById.get(dep) === 'open'))
        .map((i) => i.id),
    );
  }, [items]);

  const rows = useMemo(() => {
    const tree = buildTree(items, { includeDone: filter !== 'open' });
    const flat = flattenTree(tree, collapsed);
    if (filter === 'done') return flat.filter((n) => n.item.status === 'done');
    return flat;
  }, [items, filter, collapsed]);

  const handleDrop = useCallback(
    (draggedId: string, targetId: string | null) => {
      // Refuse a move that would put a node inside its own subtree.
      let cursor = targetId;
      const byId = new Map(items.map((i) => [i.id, i]));
      let guard = 0;
      while (cursor && guard++ < 64) {
        if (cursor === draggedId) return;
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      void moveItem(draggedId, targetId);
    },
    [items, moveItem],
  );

  return (
    <div className="view view--list">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.nav.list}</h1>
          <p className="view__sub muted">{dict.item.isCategoryAndTask}</p>
        </div>
        <Segmented<Filter>
          ariaLabel={dict.common.all}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open' as const, label: dict.nav.today },
            { value: 'all' as const, label: dict.common.all },
            { value: 'done' as const, label: dict.item.completed },
          ]}
        />
      </header>

      <QuickAdd parentId={addingUnder} autoFocus={Boolean(addingUnder)} />

      <div
        className="tree"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          const id = event.dataTransfer?.getData('text/plain');
          // Dropping on the empty area below the tree promotes to top level.
          if (id && event.target === event.currentTarget) handleDrop(id, null);
        }}
      >
        <AnimatePresence initial={false}>
          {rows.map((node) => (
            <ItemRow
              key={node.item.id}
              node={node}
              collapsed={collapsed.has(node.item.id)}
              reminders={remindersByItem.get(node.item.id) ?? []}
              blocked={blockedIds.has(node.item.id)}
              ink={node.item.inkDrawingId ? ink.get(node.item.inkDrawingId) : undefined}
              onToggleCollapse={toggleCollapse}
              onComplete={(id, done) => void toggleComplete(id, done)}
              onOpen={openDetail}
              onAddChild={(id) => setAddingUnder(addingUnder === id ? null : id)}
              onDropInto={handleDrop}
            />
          ))}
        </AnimatePresence>

        {rows.length === 0 && (
          <EmptyState
            icon={<FolderTree size={34} />}
            title={dict.common.empty}
            hint={dict.item.isCategoryAndTask}
          />
        )}
      </div>

      {rows.length > 0 && (
        <p className="tree__hint faint">
          <ListFilter size={12} /> {dict.item.progress
            .replace('{done}', String(rows.filter((r) => r.item.status === 'done').length))
            .replace('{total}', String(rows.length))}
        </p>
      )}
    </div>
  );
}
