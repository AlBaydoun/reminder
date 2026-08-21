import { motion } from 'framer-motion';
import { Ban, Play, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Countdown } from '../components/Countdown';
import { EmptyState, ProgressRing } from '../components/ui';
import { playCue } from '../lib/audio/player';
import { formatDuration, formatWhen, PRIORITY_COLORS } from '../lib/format';
import { itemPath, useData } from '../store/data';
import { useFocusSession } from '../store/focusSession';
import { useTranslation, useUi } from '../store/ui';

/**
 * A ranked queue with a work timer. Every card explains *why* it is ranked
 * where it is — a score with no reasoning is just a number to distrust.
 */
export function FocusView() {
  const { dict, locale } = useTranslation();
  const overview = useData((s) => s.overview);
  const items = useData((s) => s.items);
  const toggleComplete = useData((s) => s.toggleComplete);
  const openDetail = useUi((s) => s.openDetail);

  const [showBlocked, setShowBlocked] = useState(false);
  const startSession = useFocusSession((s) => s.start);
  const activeItemId = useFocusSession((s) => s.itemId);

  const list = useMemo(() => {
    const focus = overview?.focus ?? [];
    return showBlocked ? focus : focus.filter((f) => !f.blocked);
  }, [overview, showBlocked]);

  if (!list.length) {
    return (
      <div className="view view--focus">
        <EmptyState icon={<Target size={34} />} title={dict.focus.nothing} />
      </div>
    );
  }

  return (
    <div className="view view--focus">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.focus.title}</h1>
          <p className="view__sub muted">{dict.focus.subtitle}</p>
        </div>
        <button
          className={`btn btn-sm ${showBlocked ? 'btn-primary' : ''}`}
          onClick={() => setShowBlocked(!showBlocked)}
        >
          <Ban size={14} />
          {dict.item.blockedBy}
        </button>
      </header>

      <div className="focus-list">
        {list.map((scored, index) => {
          const path = itemPath(items, scored.item.id).slice(0, -1);
          const active = activeItemId === scored.item.id;
          return (
            <motion.article
              key={scored.item.id}
              layout
              className={`focus-card glass ${index === 0 ? 'is-top' : ''} ${scored.blocked ? 'is-blocked' : ''}`}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index * 0.03, 0.3), type: 'spring', stiffness: 220, damping: 26 }}
            >
              <div className="focus-card__score">
                <ProgressRing
                  value={scored.score / 100}
                  size={index === 0 ? 62 : 48}
                  stroke={index === 0 ? 5 : 4}
                  color={PRIORITY_COLORS[scored.item.priority]}
                >
                  <span className="mono focus-card__number">{Math.round(scored.score)}</span>
                </ProgressRing>
              </div>

              <div className="grow" onClick={() => openDetail(scored.item.id)}>
                <h3 className="focus-card__title">
                  {scored.item.icon} {scored.item.title}
                </h3>
                {path.length > 0 && <p className="faint">{path.map((p) => p.title).join(' › ')}</p>}

                <div className="focus-card__reasons">
                  {scored.reasons.map((reason) => (
                    <span key={reason.code + reason.detail} className={`chip chip--tiny ${reason.weight < 0 ? 'is-negative' : ''}`}>
                      {dict.reason[reason.code as keyof typeof dict.reason]?.replace(
                        '{detail}',
                        reason.detail ?? '',
                      ) ?? reason.code}
                    </span>
                  ))}
                  {scored.item.dueAt && <Countdown dueAt={scored.item.dueAt} size="tiny" />}
                  {scored.item.effortMinutes > 0 && (
                    <span className="chip chip--tiny">{formatDuration(scored.item.effortMinutes, dict)}</span>
                  )}
                </div>
              </div>

              <div className="focus-card__actions">
                <button
                  className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                  onClick={() => {
                    playCue('tick');
                    // The task's own estimate is the natural session length;
                    // 25 minutes when there is no estimate to go on.
                    startSession(scored.item.id, scored.item.effortMinutes || 25);
                  }}
                  disabled={scored.blocked}
                >
                  <Play size={14} />
                  {dict.focusSession.start}
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void toggleComplete(scored.item.id, true)}
                  disabled={scored.blocked}
                >
                  {dict.item.complete}
                </button>
              </div>
            </motion.article>
          );
        })}
      </div>
    </div>
  );
}
