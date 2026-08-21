import { motion } from 'framer-motion';
import { AlarmClock, CalendarClock, Flame, Sparkles, Sun, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { QuickAdd } from '../components/QuickAdd';
import { Countdown } from '../components/Countdown';
import { EmptyState, ProgressRing } from '../components/ui';
import { formatWhen, isOverdue } from '../lib/format';
import { colorFromString } from '../lib/text';
import { useAuth } from '../store/auth';
import { itemPath, useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

/** The landing screen: what is due, what is next, and what is worth doing now. */
export function TodayView() {
  const { dict, locale } = useTranslation();
  const user = useAuth((s) => s.user);
  const items = useData((s) => s.items);
  const reminders = useData((s) => s.reminders);
  const overview = useData((s) => s.overview);
  const toggleComplete = useData((s) => s.toggleComplete);
  const openDetail = useUi((s) => s.openDetail);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const key = hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening';
    return dict.today[key].replace('{name}', user?.name || '');
  }, [dict, user?.name]);

  const now = Date.now();
  const endOfDay = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }, []);

  const open = useMemo(() => items.filter((i) => !i.deletedAt && i.status === 'open'), [items]);

  const overdue = useMemo(
    () => open.filter((i) => isOverdue(i, now)).sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')),
    [open, now],
  );

  const dueToday = useMemo(
    () =>
      open
        .filter((i) => i.dueAt && new Date(i.dueAt).getTime() >= now && new Date(i.dueAt).getTime() <= endOfDay)
        .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')),
    [open, now, endOfDay],
  );

  const nextAlarms = useMemo(
    () =>
      reminders
        .filter((r) => r.nextFireAt && new Date(r.nextFireAt).getTime() > now)
        .sort((a, b) => (a.nextFireAt ?? '').localeCompare(b.nextFireAt ?? ''))
        .slice(0, 4),
    [reminders, now],
  );

  const focus = overview?.focus.filter((f) => !f.blocked).slice(0, 5) ?? [];
  const quickWins = focus.filter((f) => f.reasons.some((r) => r.code === 'quick_win')).slice(0, 4);
  const streak = overview?.streak;

  const titleFor = (id: string) => items.find((i) => i.id === id)?.title ?? '';

  const Section = ({
    icon,
    title,
    accent,
    children,
  }: {
    icon: React.ReactNode;
    title: string;
    accent?: string;
    children: React.ReactNode;
  }) => (
    <motion.section
      className="panel glass"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 26 }}
    >
      <header className="panel__head" style={accent ? { color: accent } : undefined}>
        {icon}
        <h2>{title}</h2>
      </header>
      {children}
    </motion.section>
  );

  const TaskLine = ({ id, when, tone }: { id: string; when?: string | null; tone?: 'overdue' }) => {
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    const path = itemPath(items, id).slice(0, -1);
    return (
      <div className={`task-line ${tone === 'overdue' ? 'is-overdue' : ''}`} onClick={() => openDetail(id)}>
        <button
          className="item-row__check"
          onClick={(event) => {
            event.stopPropagation();
            void toggleComplete(id, true);
          }}
          aria-label={dict.item.complete}
        >
          <span />
        </button>
        <span className="task-line__icon">{item.icon || '•'}</span>
        <span className="grow truncate">
          {item.title}
          {path.length > 0 && <span className="faint task-line__path"> · {path.map((p) => p.title).join(' › ')}</span>}
        </span>
        {when && <Countdown dueAt={when} />}
      </div>
    );
  };

  const nothingDue = overdue.length === 0 && dueToday.length === 0 && focus.length === 0;

  return (
    <div className="view view--today">
      <header className="view__head view__head--hero">
        <div className="grow">
          <motion.h1
            className="view__title view__title--hero"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {greeting}
          </motion.h1>
          <p className="view__sub muted">
            {new Date().toLocaleDateString(locale === 'ar' ? 'ar' : locale === 'ru' ? 'ru-RU' : 'en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>
        {streak && streak.current > 0 && (
          <motion.div
            className="streak-badge"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 18 }}
          >
            <Flame size={16} />
            <span className="mono">{dict.today.streak.replace('{n}', String(streak.current))}</span>
          </motion.div>
        )}
      </header>

      <QuickAdd />

      <div className="today-grid">
        {overdue.length > 0 && (
          <Section icon={<CalendarClock size={17} />} title={dict.today.overdue} accent="var(--urgent)">
            {overdue.slice(0, 6).map((item) => (
              <TaskLine key={item.id} id={item.id} when={item.dueAt} tone="overdue" />
            ))}
          </Section>
        )}

        {dueToday.length > 0 && (
          <Section icon={<Sun size={17} />} title={dict.today.dueToday}>
            {dueToday.map((item) => (
              <TaskLine key={item.id} id={item.id} when={item.dueAt} />
            ))}
          </Section>
        )}

        {focus.length > 0 && (
          <Section icon={<Sparkles size={17} />} title={dict.focus.title}>
            {focus.map((scored) => (
              <div key={scored.item.id} className="focus-line" onClick={() => openDetail(scored.item.id)}>
                <ProgressRing value={scored.score / 100} size={30} stroke={3} color={colorFromString(scored.item.title)}>
                  <span className="mono focus-line__score">{Math.round(scored.score)}</span>
                </ProgressRing>
                <span className="grow truncate">{scored.item.title}</span>
                <span className="focus-line__reasons">
                  {scored.reasons.slice(0, 1).map((reason) => (
                    <span key={reason.code} className="chip chip--tiny">
                      {dict.reason[reason.code as keyof typeof dict.reason]?.replace('{detail}', reason.detail ?? '') ??
                        reason.code}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </Section>
        )}

        {nextAlarms.length > 0 && (
          <Section icon={<AlarmClock size={17} />} title={dict.today.upNext}>
            {nextAlarms.map((reminder) => (
              <div key={reminder.id} className="task-line" onClick={() => openDetail(reminder.itemId)}>
                <span className="task-line__icon">⏰</span>
                <span className="grow truncate">{reminder.label || titleFor(reminder.itemId)}</span>
                <Countdown dueAt={reminder.nextFireAt} icon="alarm" />
              </div>
            ))}
          </Section>
        )}

        {quickWins.length > 0 && (
          <Section icon={<Zap size={17} />} title={dict.today.quickWins} accent="var(--ok)">
            {quickWins.map((scored) => (
              <TaskLine key={scored.item.id} id={scored.item.id} />
            ))}
          </Section>
        )}
      </div>

      {nothingDue && (
        <EmptyState icon={<Sun size={34} />} title={dict.today.nothingDue} hint={dict.app.tagline} />
      )}
    </div>
  );
}
