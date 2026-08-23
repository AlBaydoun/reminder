import { motion } from 'framer-motion';
import { AlarmClock, CalendarClock, Coffee, Play, Sparkles, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Countdown } from '../components/Countdown';
import { EmptyState } from '../components/ui';
import { useNow } from '../lib/clock';
import { planDay, type PlanBlock } from '../lib/planner';
import { useAuth } from '../store/auth';
import { useData } from '../store/data';
import { useFocusSession } from '../store/focusSession';
import { useTranslation, useUi } from '../store/ui';

/**
 * The day as a timetable rather than a ranking.
 *
 * A list in the right order still leaves the hardest question unanswered:
 * whether it fits before the evening, and which of it you are quietly not
 * going to do. This answers both, and says why each thing is where it is —
 * a plan you cannot interrogate is one you will not trust twice.
 */
export function PlanView() {
  const { dict, locale } = useTranslation();
  const items = useData((s) => s.items);
  const reminders = useData((s) => s.reminders);
  const user = useAuth((s) => s.user);
  const openDetail = useUi((s) => s.openDetail);
  const startSession = useFocusSession((s) => s.start);
  // Re-plans as the day moves, but only every few minutes: a timetable that
  // reshuffles under your eyes is worse than one that is slightly stale.
  const now = useNow(5 * 60_000);

  const plan = useMemo(
    () =>
      planDay(
        items,
        reminders,
        {
          workStartHour: user?.settings?.workStartHour ?? 9,
          workEndHour: user?.settings?.workEndHour ?? 19,
          capacityMinutes: user?.settings?.dailyCapacityMinutes ?? 240,
        },
        new Date(now),
      ),
    [items, reminders, user, now],
  );

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  );
  const at = (iso: string) => timeFormat.format(new Date(iso));

  const peakHour = useMemo(() => {
    let best = 0;
    plan.energyCurve.forEach((value, hour) => {
      if (value > plan.energyCurve[best]) best = hour;
    });
    return best;
  }, [plan.energyCurve]);

  if (!plan.blocks.length) {
    return (
      <div className="view view--plan">
        <header className="view__head">
          <div className="grow">
            <h1 className="view__title">{dict.plan.title}</h1>
            <p className="view__sub muted">{dict.plan.subtitle}</p>
          </div>
        </header>
        <EmptyState icon={<CalendarClock size={34} />} title={dict.plan.nothing} />
      </div>
    );
  }

  return (
    <div className="view view--plan">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.plan.title}</h1>
          <p className="view__sub muted">
            {dict.plan.summary
              .replace('{planned}', String(Math.round(plan.plannedMinutes / 6) / 10))
              .replace('{from}', at(plan.from))
              .replace('{to}', at(plan.to))}
          </p>
        </div>
        <div className="plan-meter" title={dict.plan.capacityHint}>
          <div
            className="plan-meter__fill"
            style={{ width: `${Math.min(100, (plan.plannedMinutes / Math.max(1, plan.availableMinutes)) * 100)}%` }}
          />
        </div>
      </header>

      {plan.overBy > 0 && (
        <p className="plan-warning">
          <TriangleAlert size={14} />
          {dict.plan.overBy.replace('{n}', String(Math.round(plan.overBy / 6) / 10))}
        </p>
      )}

      <p className="faint plan-energy">
        <Sparkles size={13} />
        {plan.learnedFrom > 0
          ? dict.plan.learned.replace('{hour}', String(peakHour)).replace('{n}', String(plan.learnedFrom))
          : dict.plan.notLearnedYet}
      </p>

      <ol className="plan-list">
        {plan.blocks.map((block, index) => (
          <Block
            key={`${block.start}-${block.itemId ?? block.kind}`}
            block={block}
            index={index}
            at={at}
            onOpen={() => block.itemId && openDetail(block.itemId)}
            onFocus={() => block.itemId && startSession(block.itemId, block.minutes)}
          />
        ))}
      </ol>

      {plan.leftOver.length > 0 && (
        <section className="plan-leftover">
          <h2 className="plan-leftover__title">{dict.plan.wontFit}</h2>
          <p className="faint">{dict.plan.wontFitHint}</p>
          <ul>
            {plan.leftOver.map((left) => (
              <li key={left.itemId}>
                <button className="plan-leftover__item" onClick={() => openDetail(left.itemId)}>
                  <span>{left.icon} {left.title}</span>
                  <span className="chip chip--tiny">
                    {left.reason === 'blocked' ? dict.plan.reasonBlocked : dict.plan.reasonNoRoom}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Block({
  block,
  index,
  at,
  onOpen,
  onFocus,
}: {
  block: PlanBlock;
  index: number;
  at(iso: string): string;
  onOpen(): void;
  onFocus(): void;
}) {
  const { dict } = useTranslation();
  const isBreak = block.kind === 'break';
  const isFixed = block.kind === 'fixed';

  return (
    <motion.li
      className={`plan-block is-${block.kind}`}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.025, 0.3), type: 'spring', stiffness: 240, damping: 26 }}
    >
      <time className="plan-block__time mono">{at(block.start)}</time>

      <div
        className="plan-block__body"
        style={block.color ? { borderInlineStartColor: block.color } : undefined}
      >
        {isBreak ? (
          <span className="plan-block__title muted">
            <Coffee size={14} /> {dict.plan.break}
          </span>
        ) : (
          <>
            <button className="plan-block__title" onClick={onOpen}>
              {isFixed && <AlarmClock size={14} />}
              {block.icon} {block.title}
            </button>
            <div className="plan-block__meta">
              <span className="chip chip--tiny">{dict.plan.minutes.replace('{n}', String(block.minutes))}</span>
              <span className={`chip chip--tiny reason-${block.reason}`}>
                {dict.plan.reason[block.reason as keyof typeof dict.plan.reason] ?? block.reason}
              </span>
              {block.kind === 'fixed' && <Countdown dueAt={block.start} size="tiny" />}
            </div>
          </>
        )}
      </div>

      {!isBreak && (
        <button className="btn btn-sm plan-block__go" onClick={onFocus} title={dict.focusSession.start}>
          <Play size={13} />
        </button>
      )}
    </motion.li>
  );
}
