import { motion } from 'framer-motion';
import { AlarmClock, Link2, Pin, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AlarmEditor } from '../views/AlarmsView';
import { describeRecurrence, formatWhen, fromLocalInputValue, priorityLabel, toLocalInputValue } from '../lib/format';
import { api } from '../lib/api';
import type { Item } from '../lib/types';
import { itemPath, useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';
import { Drawer, Toggle } from './ui';

/**
 * The full editor for one node. Because a category and a task are the same
 * row, this panel is the same for both — a category simply also shows what is
 * inside it.
 */
export function ItemDetail() {
  const { dict, locale } = useTranslation();
  const detailItemId = useUi((s) => s.detailItemId);
  const openDetail = useUi((s) => s.openDetail);
  const toast = useUi((s) => s.toast);

  const items = useData((s) => s.items);
  const reminders = useData((s) => s.reminders);
  const updateItem = useData((s) => s.updateItem);
  const deleteItem = useData((s) => s.deleteItem);
  const createItem = useData((s) => s.createItem);
  const deleteReminder = useData((s) => s.deleteReminder);

  const item = items.find((i) => i.id === detailItemId) ?? null;
  const [draft, setDraft] = useState<Partial<Item>>({});
  const [addingAlarm, setAddingAlarm] = useState(false);
  const [slots, setSlots] = useState<Array<{ start: string; rank: number }>>([]);
  const [newChild, setNewChild] = useState('');

  useEffect(() => {
    setDraft({});
    setSlots([]);
  }, [detailItemId]);

  const value = <K extends keyof Item>(key: K): Item[K] | undefined =>
    (draft[key] ?? item?.[key]) as Item[K] | undefined;

  const children = useMemo(
    () => items.filter((i) => i.parentId === item?.id && !i.deletedAt),
    [items, item?.id],
  );
  const path = useMemo(() => (item ? itemPath(items, item.id).slice(0, -1) : []), [items, item]);
  const itemReminders = useMemo(
    () => reminders.filter((r) => r.itemId === item?.id),
    [reminders, item?.id],
  );

  const commit = (patch: Partial<Item>) => {
    if (!item) return;
    setDraft((current) => ({ ...current, ...patch }));
    void updateItem(item.id, patch);
  };

  async function suggestSlots() {
    if (!item) return;
    try {
      const results = await api.suggestSlots(item.effortMinutes || 30);
      setSlots(results.map((s) => ({ start: s.start, rank: s.rank })));
    } catch {
      toast(dict.error.generic, 'error');
    }
  }

  return (
    <Drawer
      open={Boolean(item)}
      onClose={() => openDetail(null)}
      title={
        item && (
          <div className="detail__title-bar">
            <span className="detail__icon">{item.icon || (children.length ? '🗂️' : '•')}</span>
            <span className="truncate">{path.map((p) => p.title).join(' › ') || dict.item.root}</span>
          </div>
        )
      }
    >
      {item && (
        <div className="detail stack" style={{ gap: 18 }}>
          <div className="field">
            <label htmlFor="detail-title">{dict.item.title}</label>
            <input
              id="detail-title"
              className="input detail__title-input"
              value={String(value('title') ?? '')}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              onBlur={(event) => commit({ title: event.target.value.trim() || item.title })}
            />
          </div>

          {children.length === 0 && <p className="faint">{dict.item.isCategoryAndTask}</p>}

          <div className="row" style={{ gap: 8 }}>
            <button
              className={`btn btn-sm ${item.status === 'done' ? 'btn-primary' : ''}`}
              onClick={() => commit({ status: item.status === 'done' ? 'open' : 'done' })}
            >
              {item.status === 'done' ? dict.item.reopen : dict.item.complete}
            </button>
            <button
              className={`btn btn-sm ${item.pinned ? 'btn-primary' : ''}`}
              onClick={() => commit({ pinned: !item.pinned })}
            >
              <Pin size={14} />
              {item.pinned ? dict.item.unpin : dict.item.pin}
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                if (window.confirm(dict.item.deleteConfirm.replace('{title}', item.title))) {
                  void deleteItem(item.id);
                  openDetail(null);
                }
              }}
            >
              <Trash2 size={14} />
              {dict.common.delete}
            </button>
          </div>

          <div className="field">
            <label htmlFor="detail-notes">{dict.item.notes}</label>
            <textarea
              id="detail-notes"
              className="textarea"
              placeholder={dict.item.notesPlaceholder}
              value={String(value('notes') ?? '')}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              onBlur={(event) => commit({ notes: event.target.value })}
            />
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field grow">
              <label htmlFor="detail-due">{dict.item.due}</label>
              <input
                id="detail-due"
                type="datetime-local"
                className="input"
                value={toLocalInputValue(value('dueAt') as string | null)}
                onChange={(event) => commit({ dueAt: fromLocalInputValue(event.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="detail-effort">{dict.item.effort}</label>
              <input
                id="detail-effort"
                type="number"
                min={0}
                step={5}
                className="input"
                style={{ width: 110 }}
                value={Number(value('effortMinutes') ?? 0)}
                onChange={(event) => commit({ effortMinutes: Number(event.target.value) })}
              />
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => void suggestSlots()}>
              <Link2 size={14} />
              {dict.focus.subtitle.split(',')[0]}
            </button>
            {slots.map((slot) => (
              <button key={slot.start} className="chip chip--action" onClick={() => commit({ dueAt: slot.start })}>
                {formatWhen(slot.start, locale, dict)}
              </button>
            ))}
          </div>

          <div className="field">
            <label>{dict.priority.label}</label>
            <div className="chip-row">
              {[0, 1, 2, 3, 4].map((priority) => (
                <button
                  key={priority}
                  className={`chip chip--action ${item.priority === priority ? 'is-active' : ''}`}
                  onClick={() => commit({ priority })}
                >
                  {priorityLabel(priority, dict)}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>{dict.item.energy}</label>
            <div className="chip-row">
              {[1, 2, 3, 4, 5].map((energy) => (
                <button
                  key={energy}
                  className={`chip chip--action ${item.energy === energy ? 'is-active' : ''}`}
                  onClick={() => commit({ energy })}
                >
                  {dict.energy[`e${energy}` as keyof typeof dict.energy]}
                </button>
              ))}
            </div>
          </div>

          {item.recurrence && (
            <div className="field">
              <label>{dict.item.repeats}</label>
              <div className="row" style={{ gap: 8 }}>
                <span className="chip">{describeRecurrence(item.recurrence, dict, locale)}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => commit({ recurrence: null })}>
                  {dict.common.remove}
                </button>
              </div>
            </div>
          )}

          <section>
            <header className="detail__section-head">
              <AlarmClock size={15} />
              <h3>{dict.reminder.alarms}</h3>
              <button className="btn btn-sm" onClick={() => setAddingAlarm(true)}>
                <Plus size={14} />
                {dict.item.addReminder}
              </button>
            </header>
            {itemReminders.length === 0 ? (
              <p className="muted">{dict.reminder.noAlarms}</p>
            ) : (
              itemReminders.map((reminder) => (
                <div key={reminder.id} className="detail__row">
                  <span className="grow truncate">
                    {reminder.nextFireAt
                      ? dict.reminder.nextAt.replace('{when}', formatWhen(reminder.nextFireAt, locale, dict))
                      : dict.reminder.missed}
                    {reminder.rrule && ` · ${describeRecurrence(reminder.rrule, dict, locale)}`}
                  </span>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={() => void deleteReminder(reminder.id)}
                    aria-label={dict.common.delete}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </section>

          <section>
            <header className="detail__section-head">
              <h3>{dict.item.children.replace('{n}', String(children.length))}</h3>
            </header>
            {children.map((child) => (
              <div key={child.id} className="detail__row detail__row--clickable" onClick={() => openDetail(child.id)}>
                <span className="task-line__icon">{child.icon || '•'}</span>
                <span className="grow truncate">{child.title}</span>
                {child.status === 'done' && <span className="chip chip--tiny">{dict.item.completed}</span>}
              </div>
            ))}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input
                className="input grow"
                placeholder={dict.item.addChild}
                value={newChild}
                onChange={(event) => setNewChild(event.target.value)}
                onKeyDown={async (event) => {
                  if (event.key !== 'Enter' || !newChild.trim()) return;
                  await createItem({ title: newChild.trim(), parentId: item.id });
                  setNewChild('');
                }}
              />
              <button
                className="btn btn-primary"
                disabled={!newChild.trim()}
                onClick={async () => {
                  await createItem({ title: newChild.trim(), parentId: item.id });
                  setNewChild('');
                }}
              >
                <Plus size={15} />
              </button>
            </div>
          </section>

          <Toggle
            checked={item.status === 'archived'}
            onChange={(next) => commit({ status: next ? 'archived' : 'open' })}
            label={dict.nav.trash}
            hint={dict.item.createdAt.replace('{when}', formatWhen(item.createdAt, locale, dict))}
          />

          <AlarmEditor
            open={addingAlarm}
            reminder={null}
            presetItemId={item.id}
            onClose={() => setAddingAlarm(false)}
          />
        </div>
      )}
    </Drawer>
  );
}
