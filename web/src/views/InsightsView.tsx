import { motion } from 'framer-motion';
import { Activity, AlertTriangle, Copy, GitBranch, Info, Merge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '../components/ui';
import { api } from '../lib/api';
import type { DuplicateGroup } from '../lib/types';
import { useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

const SEVERITY_ICON = {
  info: Info,
  warn: AlertTriangle,
  urgent: AlertTriangle,
} as const;

/** Everything the reasoning engine noticed, with the evidence behind it. */
export function InsightsView() {
  const { dict } = useTranslation();
  const overview = useData((s) => s.overview);
  const items = useData((s) => s.items);
  const deleteItem = useData((s) => s.deleteItem);
  const openDetail = useUi((s) => s.openDetail);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);

  useEffect(() => {
    api.duplicates().then(setDuplicates).catch(() => setDuplicates([]));
  }, [items.length]);

  const insights = overview?.insights ?? [];
  const streak = overview?.streak;
  const cycles = overview?.dependencies.cycles ?? [];
  const titleFor = (id: string) => items.find((i) => i.id === id)?.title ?? id.slice(0, 6);

  return (
    <div className="view view--insights">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.insight.title}</h1>
          <p className="view__sub muted">{dict.focus.subtitle}</p>
        </div>
      </header>

      {insights.length === 0 && duplicates.length === 0 ? (
        <EmptyState icon={<Activity size={34} />} title={dict.insight.none} />
      ) : (
        <div className="insight-grid">
          {insights.map((insight, index) => {
            const Icon = SEVERITY_ICON[insight.severity];
            const template = dict.insight[insight.code as keyof typeof dict.insight];
            const text =
              typeof template === 'string'
                ? Object.entries(insight.values).reduce(
                    (acc, [key, value]) => acc.replace(`{${key}}`, String(value)),
                    template,
                  )
                : insight.code;

            return (
              <motion.article
                key={insight.code}
                className={`insight-card glass is-${insight.severity}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04 }}
              >
                <Icon size={18} className="insight-card__icon" />
                <div className="grow">
                  <p className="insight-card__text">{text}</p>
                  {insight.itemIds && insight.itemIds.length > 0 && (
                    <div className="insight-card__items">
                      {insight.itemIds.slice(0, 6).map((id) => (
                        <button key={id} className="chip chip--action" onClick={() => openDetail(id)}>
                          {titleFor(id)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </motion.article>
            );
          })}
        </div>
      )}

      {streak && (
        <section className="panel glass">
          <header className="panel__head">
            <Activity size={17} />
            <h2>{dict.today.streak.replace('{n}', String(streak.current))}</h2>
          </header>
          <div className="streak-grid" role="img" aria-label={dict.today.completedToday.replace('{n}', String(streak.completedToday))}>
            {streak.last30.map((day) => (
              <span
                key={day.date}
                className="streak-cell"
                title={`${day.date}: ${day.count}`}
                style={{
                  opacity: day.count === 0 ? 0.14 : Math.min(1, 0.35 + day.count * 0.18),
                  background: day.count === 0 ? 'var(--text-faint)' : 'var(--ok)',
                }}
              />
            ))}
          </div>
        </section>
      )}

      {cycles.length > 0 && (
        <section className="panel glass">
          <header className="panel__head" style={{ color: 'var(--warn)' }}>
            <GitBranch size={17} />
            <h2>{dict.insight.dependency_cycle.replace('{count}', String(cycles.length))}</h2>
          </header>
          {cycles.map((cycle, index) => (
            <p key={index} className="cycle-line">
              {cycle.map((id) => titleFor(id)).join(' → ')}
            </p>
          ))}
        </section>
      )}

      {duplicates.length > 0 && (
        <section className="panel glass">
          <header className="panel__head">
            <Copy size={17} />
            <h2>{dict.insight.possible_duplicates.replace('{count}', String(duplicates.length)).replace('{example}', '')}</h2>
          </header>
          {duplicates.map((group) => (
            <div key={group.ids.join()} className="duplicate-row">
              <Merge size={15} className="faint" />
              <div className="grow">
                {group.titles.map((title, index) => (
                  <button key={group.ids[index]} className="chip chip--action" onClick={() => openDetail(group.ids[index])}>
                    {title}
                  </button>
                ))}
              </div>
              <span className="mono faint">{Math.round(group.similarity * 100)}%</span>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void deleteItem(group.ids[group.ids.length - 1])}
              >
                {dict.common.delete}
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
