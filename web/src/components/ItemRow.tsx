import { motion } from 'framer-motion';
import {
  AlarmClock,
  Check,
  ChevronRight,
  CornerDownRight,
  Lock,
  PenLine,
  Pin,
  Repeat,
} from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { isOverdue, PRIORITY_COLORS } from '../lib/format';
import { colorFromString } from '../lib/text';
import type { Reminder } from '../lib/types';
import type { TreeNode } from '../store/data';
import { useTranslation, useUi } from '../store/ui';
import { Countdown } from './Countdown';
import { Confetti, ProgressRing } from './ui';

export interface ItemRowProps {
  node: TreeNode;
  collapsed: boolean;
  reminders: Reminder[];
  blocked: boolean;
  /** Thumbnail of the handwriting, when this row was written rather than typed. */
  ink?: string;
  onToggleCollapse(id: string): void;
  onComplete(id: string, done: boolean): void;
  onOpen(id: string): void;
  onAddChild(id: string): void;
  onDropInto?(draggedId: string, targetId: string | null): void;
  compact?: boolean;
}

/**
 * One row of the tree. The same component renders a category and a task,
 * because in this app they are the same thing — the only difference is
 * whether anything lives inside it.
 */
export function ItemRow({
  node,
  collapsed,
  reminders,
  blocked,
  onToggleCollapse,
  onComplete,
  onOpen,
  onAddChild,
  onDropInto,
  compact,
  ink,
}: ItemRowProps) {
  const { dict, locale } = useTranslation();
  const dir = useUi((s) => s.dir);
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const { item } = node;
  const done = item.status === 'done';
  const overdue = isOverdue(item);
  const accent = item.color || colorFromString(item.title);
  const progress = node.totalDescendants > 0 ? node.doneDescendants / node.totalDescendants : 0;

  const handleComplete = (event: MouseEvent) => {
    event.stopPropagation();
    if (!done) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setBurst({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      window.setTimeout(() => setBurst(null), 900);
    }
    onComplete(item.id, !done);
  };

  return (
    <>
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 30 }}
        className={[
          'item-row',
          done ? 'is-done' : '',
          overdue ? 'is-overdue' : '',
          blocked ? 'is-blocked' : '',
          dragOver ? 'is-drag-over' : '',
          compact ? 'is-compact' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          // Indent with a logical property so RTL indents from the right.
          [dir === 'rtl' ? 'paddingRight' : 'paddingLeft']: 10 + node.depth * 20,
          ['--row-accent' as string]: accent,
        }}
        onClick={() => onOpen(item.id)}
        draggable
        onDragStart={(event) => {
          (event as unknown as DragEvent).dataTransfer?.setData('text/plain', item.id);
        }}
        onDragOver={(event) => {
          if (!onDropInto) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          setDragOver(false);
          if (!onDropInto) return;
          event.preventDefault();
          const draggedId = (event as unknown as DragEvent).dataTransfer?.getData('text/plain');
          if (draggedId && draggedId !== item.id) onDropInto(draggedId, item.id);
        }}
      >
        {node.isCategory ? (
          <button
            className="item-row__chevron"
            onClick={(event) => {
              event.stopPropagation();
              onToggleCollapse(item.id);
            }}
            aria-expanded={!collapsed}
            aria-label={item.title}
          >
            {/* Collapsed points along the reading direction, so in Arabic it
                points left rather than back into the text. */}
            <motion.span
              animate={{ rotate: collapsed ? (dir === 'rtl' ? 180 : 0) : 90 }}
              transition={{ duration: 0.18 }}
            >
              <ChevronRight size={16} />
            </motion.span>
          </button>
        ) : (
          <span className="item-row__chevron item-row__chevron--empty" />
        )}

        <button
          className={`item-row__check ${done ? 'is-done' : ''}`}
          onClick={handleComplete}
          aria-label={done ? dict.item.reopen : dict.item.complete}
          aria-pressed={done}
          disabled={blocked && !done}
          title={blocked ? dict.item.blockedBy : undefined}
        >
          {blocked && !done ? <Lock size={12} /> : <Check size={14} />}
        </button>

        <span className="item-row__icon" aria-hidden>
          {item.icon || (node.isCategory ? '🗂️' : '•')}
        </span>

        {ink && item.displayMode === 'ink' ? (
          // The handwriting is the row's face; the transcription sits under it
          // so the words stay readable, selectable and obviously searchable.
          <span className="item-row__ink grow">
            <img src={ink} alt={item.title} draggable={false} />
            <span className="item-row__ink-text faint truncate">{item.title}</span>
          </span>
        ) : (
          <span className="item-row__title grow truncate">{item.title}</span>
        )}

        <span className="item-row__meta">
          {item.displayMode === 'ink' && (
            <PenLine size={13} className="item-row__handwritten" aria-label={dict.item.handwritten} />
          )}
          {item.pinned && <Pin size={13} className="item-row__pin" aria-label={dict.item.pinned} />}
          {item.recurrence && <Repeat size={13} aria-label={dict.item.repeats} />}
          {reminders.length > 0 && (
            <span className="item-row__alarms" title={dict.reminder.alarms}>
              <AlarmClock size={13} />
              {reminders.length > 1 && <span className="mono">{reminders.length}</span>}
            </span>
          )}
          {/* The date says when; the countdown says how long is left. Only the
              second one changes how the row feels as the day goes on. */}
          <Countdown dueAt={item.dueAt} done={done} />
          {item.priority !== 2 && (
            <span
              className="item-row__priority"
              style={{ background: PRIORITY_COLORS[item.priority] }}
              aria-hidden
            />
          )}
          {node.isCategory && (
            <ProgressRing value={progress} size={26} stroke={2.5} color={accent}>
              <span className="item-row__count mono">{node.totalDescendants - node.doneDescendants}</span>
            </ProgressRing>
          )}
          <button
            className="item-row__add"
            onClick={(event) => {
              event.stopPropagation();
              onAddChild(item.id);
            }}
            aria-label={dict.item.addChild}
            title={dict.item.addChild}
          >
            <CornerDownRight size={14} />
          </button>
        </span>
      </motion.div>

      {burst && <Confetti x={burst.x} y={burst.y} color={accent} />}
    </>
  );
}
