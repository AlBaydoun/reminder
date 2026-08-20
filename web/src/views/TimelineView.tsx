import { motion } from 'framer-motion';
import { CalendarRange } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '../components/ui';
import { formatDuration, formatTime, isOverdue } from '../lib/format';
import { colorFromString } from '../lib/text';
import { useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

/**
 * A fortnight of workload at a glance. The bar is minutes of estimated effort
 * against the daily capacity from settings, so an overbooked day is visible
 * days before it arrives instead of on the morning it ruins.
 */
export function TimelineView() {
  const { dict, locale } = useTranslation();
  const overview = useData((s) => s.overview);
  const items = useData((s) => s.items);
  const openDetail = useUi((s) => s.openDetail);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const forecast = overview?.forecast ?? [];
  const peak = Math.max(1, ...forecast.map((d) => Math.max(d.minutes, d.capacity)));

  const itemsByDay = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const item of items) {
      if (item.deletedAt || item.status !== 'open' || !item.dueAt) continue;
      const date = new Date(item.dueAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [items]);

  if (!forecast.length) {
    return (
      <div className="view view--timeline">
        <EmptyState icon={<CalendarRange size={34} />} title={dict.common.empty} />
      </div>
    );
  }

  const dayItems = selectedDate ? (itemsByDay.get(selectedDate) ?? []) : [];

  return (
    <div className="view view--timeline">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.timeline.title}</h1>
          <p className="view__sub muted">
            {dict.timeline.capacity}: {formatDuration(forecast[0]?.capacity ?? 240, dict)} / {dict.common.days.replace('{n}', '1')}
          </p>
        </div>
      </header>

      <div className="timeline">
        {forecast.map((day, index) => {
          const date = new Date(`${day.date}T12:00:00`);
          const height = (day.minutes / peak) * 100;
          const capacityLine = (day.capacity / peak) * 100;
          const color = day.overloaded ? 'var(--urgent)' : day.overdue > 0 ? 'var(--warn)' : 'var(--accent)';

          return (
            <button
              key={day.date}
              className={`timeline__day ${selectedDate === day.date ? 'is-selected' : ''}`}
              onClick={() => setSelectedDate(selectedDate === day.date ? null : day.date)}
            >
              <div className="timeline__bar-track">
                <span className="timeline__capacity" style={{ bottom: `${capacityLine}%` }} />
                <motion.span
                  className="timeline__bar"
                  style={{ background: color }}
                  initial={{ height: 0 }}
                  animate={{ height: `${Math.max(2, height)}%` }}
                  transition={{ delay: index * 0.03, type: 'spring', stiffness: 180, damping: 22 }}
                />
              </div>
              <span className="timeline__weekday">
                {date.toLocaleDateString(locale === 'ar' ? 'ar' : locale === 'ru' ? 'ru-RU' : 'en-GB', {
                  weekday: 'short',
                })}
              </span>
              <span className="timeline__date mono">{date.getDate()}</span>
              {day.count > 0 && <span className="timeline__count mono">{day.count}</span>}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <motion.section
          className="panel glass"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <header className="panel__head">
            <h2>
              {new Date(`${selectedDate}T12:00:00`).toLocaleDateString(
                locale === 'ar' ? 'ar' : locale === 'ru' ? 'ru-RU' : 'en-GB',
                { weekday: 'long', day: 'numeric', month: 'long' },
              )}
            </h2>
          </header>
          {dayItems.length === 0 ? (
            <p className="muted">{dict.timeline.noWork}</p>
          ) : (
            dayItems
              .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))
              .map((item) => (
                <div
                  key={item.id}
                  className={`task-line ${isOverdue(item) ? 'is-overdue' : ''}`}
                  onClick={() => openDetail(item.id)}
                >
                  <span
                    className="task-line__dot"
                    style={{ background: item.color || colorFromString(item.title) }}
                  />
                  <span className="mono faint">{item.dueAt ? formatTime(item.dueAt, locale) : ''}</span>
                  <span className="grow truncate">
                    {item.icon} {item.title}
                  </span>
                  {item.effortMinutes > 0 && (
                    <span className="chip chip--tiny">{formatDuration(item.effortMinutes, dict)}</span>
                  )}
                </div>
              ))
          )}
        </motion.section>
      )}
    </div>
  );
}
