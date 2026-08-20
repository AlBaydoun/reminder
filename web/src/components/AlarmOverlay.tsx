import { AnimatePresence, motion } from 'framer-motion';
import { AlarmClockOff, BellRing, Check, Clock } from 'lucide-react';
import { formatWhen } from '../lib/format';
import { useAlarms } from '../store/alarms';
import { useTranslation } from '../store/ui';

/**
 * The ringing screen. Several alarms can be up at once — each gets its own
 * card with its own controls, because silencing one should never silence
 * another that has not been seen yet.
 */
export function AlarmOverlay() {
  const { dict, locale } = useTranslation();
  const ringing = useAlarms((s) => s.ringing);
  const snooze = useAlarms((s) => s.snooze);
  const dismiss = useAlarms((s) => s.dismiss);
  const complete = useAlarms((s) => s.completeFromAlarm);

  return (
    <AnimatePresence>
      {ringing.length > 0 && (
        <motion.div
          className="alarm-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="alertdialog"
          aria-label={dict.reminder.ringingNow}
        >
          <div className="alarm-overlay__stack">
            {ringing.map(({ reminder, missed }, index) => (
              <motion.article
                key={reminder.id}
                className="alarm-ring glass"
                initial={{ opacity: 0, scale: 0.86, y: 40 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -20 }}
                transition={{ type: 'spring', stiffness: 220, damping: 22, delay: index * 0.06 }}
              >
                <div className="alarm-ring__pulse" aria-hidden>
                  <span />
                  <span />
                  <span />
                  <BellRing size={38} />
                </div>

                <p className="alarm-ring__label">
                  {missed ? dict.reminder.missed : dict.reminder.ringingNow}
                </p>
                <h2 className="alarm-ring__title">
                  {reminder.item.icon} {reminder.item.title}
                </h2>
                {reminder.label && <p className="muted">{reminder.label}</p>}
                <p className="faint mono">{formatWhen(reminder.nextFireAt ?? reminder.fireAt, locale, dict)}</p>

                <div className="alarm-ring__actions">
                  <button className="btn" onClick={() => void snooze(reminder.id, 5)}>
                    <Clock size={15} />
                    {dict.reminder.snoozeFor.replace('{n}', '5')}
                  </button>
                  <button className="btn" onClick={() => void snooze(reminder.id)}>
                    <Clock size={15} />
                    {dict.reminder.snoozeFor.replace('{n}', String(reminder.snoozeMinutes))}
                  </button>
                  <button className="btn btn-primary" onClick={() => void complete(reminder.id)}>
                    <Check size={15} />
                    {dict.reminder.markDone}
                  </button>
                  <button className="btn btn-ghost" onClick={() => void dismiss(reminder.id)}>
                    <AlarmClockOff size={15} />
                    {dict.reminder.dismiss}
                  </button>
                </div>
              </motion.article>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
