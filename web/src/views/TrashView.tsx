import { motion } from 'framer-motion';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState } from '../components/ui';
import { formatRelative } from '../lib/format';
import { useData } from '../store/data';
import { useTranslation } from '../store/ui';

export function TrashView() {
  const { dict, locale } = useTranslation();
  const items = useData((s) => s.items);
  const restoreItem = useData((s) => s.restoreItem);
  const purgeItem = useData((s) => s.purgeItem);

  const deleted = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return items
      .filter((i) => i.deletedAt)
      // Only show the top of each deleted branch: listing every child of a
      // deleted category is noise, since restoring the parent brings them back.
      .filter((i) => !i.parentId || !byId.get(i.parentId)?.deletedAt)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }, [items]);

  if (!deleted.length) {
    return (
      <div className="view view--trash">
        <EmptyState icon={<Trash2 size={34} />} title={dict.trash.empty} />
      </div>
    );
  }

  return (
    <div className="view view--trash">
      <header className="view__head">
        <h1 className="view__title">{dict.trash.title}</h1>
      </header>

      <div className="trash-list">
        {deleted.map((item) => (
          <motion.div key={item.id} layout className="trash-row glass" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="task-line__icon">{item.icon || '•'}</span>
            <span className="grow truncate">{item.title}</span>
            <span className="faint">{item.deletedAt && formatRelative(item.deletedAt, locale)}</span>
            <button className="btn btn-sm" onClick={() => void restoreItem(item.id)}>
              <RotateCcw size={14} />
              {dict.trash.restore}
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                if (window.confirm(dict.trash.deleteForeverConfirm.replace('{title}', item.title))) {
                  void purgeItem(item.id);
                }
              }}
            >
              <Trash2 size={14} />
              {dict.trash.deleteForever}
            </button>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
