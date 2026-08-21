import { motion, AnimatePresence } from 'framer-motion';
import { AlarmClock } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CountdownClock } from './Countdown';
import { urgencyOf } from '../lib/countdown';
import { useNow } from '../lib/clock';
import { useAlarms } from '../store/alarms';
import { useData } from '../store/data';
import { useTranslation } from '../store/ui';

/**
 * The next alarm, always in view.
 *
 * Concentration depends on trusting that nothing is going to be missed. A
 * countdown sitting in the header removes the reason to keep checking: you can
 * see at any moment what is coming and how long you have.
 */
export function NextAlarmBar() {
  const { dict } = useTranslation();
  const ringing = useAlarms((s) => s.ringing);
  // Deliberately the full reminder list, not the alarm engine's armed set: that
  // set is limited to the next couple of days because it drives *firing*, and
  // an alarm three days out is exactly the one you want to be reminded exists.
  const reminders = useData((s) => s.reminders);
  const items = useData((s) => s.items);
  const navigate = useNavigate();
  const now = useNow(30_000);

  const next = useMemo(() => {
    const byId = new Map(items.filter((i) => !i.deletedAt).map((i) => [i.id, i]));
    for (const reminder of [...reminders].sort((a, b) =>
      (a.nextFireAt ?? '').localeCompare(b.nextFireAt ?? ''),
    )) {
      if (!reminder.nextFireAt || new Date(reminder.nextFireAt).getTime() <= now) continue;
      const item = byId.get(reminder.itemId);
      // A finished task is not something still to come; skip past it to the
      // next alarm that actually matters rather than showing an empty bar.
      if (!item || item.status === 'done') continue;
      return { reminder, item };
    }
    return null;
  }, [reminders, items, now]);

  // While something is actually ringing, the alarm screen has the floor.
  if (!next?.reminder.nextFireAt || ringing.length > 0) return null;
  const urgency = urgencyOf(new Date(next.reminder.nextFireAt).getTime() - now);

  return (
    <AnimatePresence>
      <motion.button
        key={next.reminder.id}
        className={`next-alarm glass is-${urgency}`}
        onClick={() => navigate('/alarms')}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        title={dict.health.nextAlarm}
      >
        <AlarmClock size={15} className="next-alarm__icon" />
        <span className="next-alarm__title truncate">
          {next.item.icon} {next.reminder.label || next.item.title}
        </span>
        <CountdownClock target={next.reminder.nextFireAt} className="next-alarm__clock" />
      </motion.button>
    </AnimatePresence>
  );
}
