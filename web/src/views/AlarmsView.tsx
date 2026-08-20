import { motion } from 'framer-motion';
import { AlarmClock, BellOff, BellRing, Plus, Trash2, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { SoundPicker } from '../components/SoundPicker';
import { EmptyState, Modal, Toggle } from '../components/ui';
import { unlockAudio } from '../lib/audio/player';
import { describeRecurrence, formatWhen, fromLocalInputValue, toLocalInputValue } from '../lib/format';
import type { Recurrence, Reminder } from '../lib/types';
import { useAlarms } from '../store/alarms';
import { useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

const REPEAT_PRESETS: Array<{ key: string; rule: Recurrence | null }> = [
  { key: 'never', rule: null },
  { key: 'daily', rule: { freq: 'daily', interval: 1 } },
  { key: 'weekdays', rule: { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] } },
  { key: 'weekly', rule: { freq: 'weekly', interval: 1 } },
  { key: 'biweekly', rule: { freq: 'weekly', interval: 2 } },
  { key: 'monthly', rule: { freq: 'monthly', interval: 1 } },
  { key: 'quarterly', rule: { freq: 'monthly', interval: 3 } },
  { key: 'yearly', rule: { freq: 'yearly', interval: 1 } },
];

export function AlarmsView() {
  const { dict, locale } = useTranslation();
  const items = useData((s) => s.items);
  const reminders = useData((s) => s.reminders);
  const deleteReminder = useData((s) => s.deleteReminder);
  const refreshSounds = useData((s) => s.refreshSounds);
  const openDetail = useUi((s) => s.openDetail);
  const notificationsGranted = useAlarms((s) => s.notificationsGranted);
  const requestNotifications = useAlarms((s) => s.requestNotifications);
  const testRing = useAlarms((s) => s.testRing);

  const [editing, setEditing] = useState<Reminder | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void refreshSounds();
  }, [refreshSounds]);

  const sorted = useMemo(
    () =>
      [...reminders].sort((a, b) => {
        const at = a.nextFireAt ?? '9999';
        const bt = b.nextFireAt ?? '9999';
        return at.localeCompare(bt);
      }),
    [reminders],
  );

  const titleFor = (itemId: string) => items.find((i) => i.id === itemId)?.title ?? '—';
  const iconFor = (itemId: string) => items.find((i) => i.id === itemId)?.icon || '⏰';

  return (
    <div className="view view--alarms">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.reminder.alarms}</h1>
          <p className="view__sub muted">{dict.reminder.backgroundWarning}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={16} />
          {dict.reminder.newAlarm}
        </button>
      </header>

      {!notificationsGranted && (
        <motion.div className="notice glass" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
          <BellRing size={18} />
          <div className="grow">
            <strong>{dict.reminder.permissionTitle}</strong>
            <p className="muted">{dict.reminder.permissionBody}</p>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={async () => {
              await unlockAudio();
              await requestNotifications();
            }}
          >
            {dict.reminder.permissionAllow}
          </button>
        </motion.div>
      )}

      {sorted.length === 0 ? (
        <EmptyState icon={<BellOff size={34} />} title={dict.reminder.noAlarms} />
      ) : (
        <div className="alarm-list">
          {sorted.map((reminder, index) => (
            <motion.article
              key={reminder.id}
              layout
              className={`alarm-card glass ${reminder.status === 'snoozed' ? 'is-snoozed' : ''}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index * 0.03, 0.25) }}
            >
              <span className="alarm-card__icon">{iconFor(reminder.itemId)}</span>
              <div className="grow" onClick={() => openDetail(reminder.itemId)}>
                <h3 className="truncate">{reminder.label || titleFor(reminder.itemId)}</h3>
                <p className="muted">
                  {reminder.nextFireAt
                    ? dict.reminder.nextAt.replace('{when}', formatWhen(reminder.nextFireAt, locale, dict))
                    : dict.reminder.missed}
                  {reminder.rrule && ` · ${describeRecurrence(reminder.rrule, dict, locale)}`}
                </p>
              </div>
              <div className="alarm-card__actions">
                {reminder.escalate && <span className="chip chip--tiny">{dict.reminder.escalate}</span>}
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={dict.reminder.preview}
                  onClick={async () => {
                    await unlockAudio();
                    testRing({
                      ...reminder,
                      item: {
                        id: reminder.itemId,
                        title: titleFor(reminder.itemId),
                        icon: iconFor(reminder.itemId),
                        color: '',
                        status: 'open',
                      },
                    });
                  }}
                >
                  <Volume2 size={15} />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(reminder)} aria-label={dict.common.edit}>
                  <AlarmClock size={15} />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => void deleteReminder(reminder.id)}
                  aria-label={dict.common.delete}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </motion.article>
          ))}
        </div>
      )}

      <AlarmEditor
        open={creating || Boolean(editing)}
        reminder={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

/** Create or edit one alarm. Used from this view and from the item drawer. */
export function AlarmEditor({
  open,
  reminder,
  presetItemId,
  onClose,
}: {
  open: boolean;
  reminder: Reminder | null;
  presetItemId?: string;
  onClose(): void;
}) {
  const { dict, locale } = useTranslation();
  const items = useData((s) => s.items);
  const createReminder = useData((s) => s.createReminder);
  const updateReminder = useData((s) => s.updateReminder);
  const toast = useUi((s) => s.toast);

  const [itemId, setItemId] = useState(reminder?.itemId ?? presetItemId ?? '');
  const [fireAt, setFireAt] = useState(toLocalInputValue(reminder?.fireAt ?? defaultFireAt()));
  const [repeatKey, setRepeatKey] = useState('never');
  const [rule, setRule] = useState<Recurrence | null>(reminder?.rrule ?? null);
  const [soundId, setSoundId] = useState<string | null>(reminder?.soundId ?? null);
  const [escalate, setEscalate] = useState(reminder?.escalate ?? false);
  const [vibrateOn, setVibrateOn] = useState(reminder?.vibrate ?? true);
  const [lead, setLead] = useState<number[]>(reminder?.leadMinutes ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItemId(reminder?.itemId ?? presetItemId ?? '');
    setFireAt(toLocalInputValue(reminder?.fireAt ?? defaultFireAt()));
    setRule(reminder?.rrule ?? null);
    setSoundId(reminder?.soundId ?? null);
    setEscalate(reminder?.escalate ?? false);
    setVibrateOn(reminder?.vibrate ?? true);
    setLead(reminder?.leadMinutes ?? []);
    const matched = REPEAT_PRESETS.find(
      (preset) => JSON.stringify(preset.rule) === JSON.stringify(reminder?.rrule ?? null),
    );
    setRepeatKey(matched?.key ?? (reminder?.rrule ? 'custom' : 'never'));
  }, [open, reminder, presetItemId]);

  const selectable = useMemo(
    () => items.filter((i) => !i.deletedAt).sort((a, b) => a.title.localeCompare(b.title)),
    [items],
  );

  async function save() {
    const iso = fromLocalInputValue(fireAt);
    if (!itemId || !iso) {
      toast(dict.error.generic, 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        itemId,
        fireAt: iso,
        rrule: rule,
        soundId,
        escalate,
        vibrate: vibrateOn,
        leadMinutes: lead,
      };
      if (reminder) await updateReminder(reminder.id, payload);
      else await createReminder(payload);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={reminder ? dict.reminder.title : dict.reminder.newAlarm}
      width={620}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {dict.common.cancel}
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !itemId}>
            {saving ? dict.common.saving : dict.common.save}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <div className="field">
          <label htmlFor="alarm-item">{dict.item.title}</label>
          <select id="alarm-item" className="select" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">—</option>
            {selectable.map((item) => (
              <option key={item.id} value={item.id}>
                {item.icon} {item.title}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="alarm-when">{dict.reminder.when}</label>
          <input
            id="alarm-when"
            type="datetime-local"
            className="input"
            value={fireAt}
            onChange={(e) => setFireAt(e.target.value)}
          />
        </div>

        <div className="field">
          <label>{dict.item.repeats}</label>
          <div className="chip-row">
            {REPEAT_PRESETS.map((preset) => (
              <button
                key={preset.key}
                className={`chip chip--action ${repeatKey === preset.key ? 'is-active' : ''}`}
                onClick={() => {
                  setRepeatKey(preset.key);
                  setRule(preset.rule);
                }}
              >
                {dict.repeat[preset.key as keyof typeof dict.repeat] as string}
              </button>
            ))}
          </div>
          {rule && <p className="faint">{describeRecurrence(rule, dict, locale)}</p>}
        </div>

        <div className="field">
          <label>{dict.reminder.leadTime}</label>
          <div className="chip-row">
            {[5, 10, 30, 60, 1440].map((minutes) => (
              <button
                key={minutes}
                className={`chip chip--action ${lead.includes(minutes) ? 'is-active' : ''}`}
                onClick={() =>
                  setLead(lead.includes(minutes) ? lead.filter((m) => m !== minutes) : [...lead, minutes])
                }
              >
                {minutes >= 1440
                  ? dict.common.days.replace('{n}', String(minutes / 1440))
                  : dict.common.minutes.replace('{n}', String(minutes))}
              </button>
            ))}
          </div>
        </div>

        <Toggle checked={escalate} onChange={setEscalate} label={dict.reminder.escalate} />
        <Toggle checked={vibrateOn} onChange={setVibrateOn} label={dict.reminder.vibrate} />

        <div className="field">
          <label>{dict.reminder.sound}</label>
          <SoundPicker value={soundId} onChange={setSoundId} />
        </div>
      </div>
    </Modal>
  );
}

function defaultFireAt(): string {
  // Default to the next round hour — nobody sets an alarm for 14:37.
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.toISOString();
}
