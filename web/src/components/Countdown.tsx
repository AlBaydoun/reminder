import { AlarmClock, CalendarClock } from 'lucide-react';
import { resolutionFor, useNow } from '../lib/clock';
import { describeCountdown, formatCountdown, type Urgency } from '../lib/countdown';
import { formatWhen } from '../lib/format';
import { useTranslation } from '../store/ui';

/**
 * The live countdown shown on anything with a deadline.
 *
 * Two pieces of information, because they answer different questions: the date
 * tells you *when*, the countdown tells you *how long you have*. Only the
 * second one changes how you feel about a task at 4pm, which is why it is the
 * one that ticks and the one that carries the colour.
 */
export function Countdown({
  dueAt,
  /** Hide once the task is finished — a completed task has no deadline left. */
  done = false,
  showDate = true,
  size = 'normal',
  icon,
}: {
  dueAt: string | null | undefined;
  done?: boolean;
  showDate?: boolean;
  size?: 'normal' | 'tiny' | 'large';
  icon?: 'alarm' | 'calendar' | 'none';
}) {
  const { dict, locale } = useTranslation();
  const target = dueAt ? new Date(dueAt).getTime() : 0;
  // Ask the shared clock only for the precision this deadline needs.
  const now = useNow(target ? resolutionFor(target) : 60_000);

  if (!dueAt) return null;
  const parts = formatCountdown(dueAt, dict, now);
  if (!parts) return null;

  const Icon = icon === 'alarm' ? AlarmClock : CalendarClock;
  const urgency: Urgency = done ? 'distant' : parts.urgency;

  return (
    <span className={`countdown countdown--${size} is-${urgency} ${done ? 'is-done' : ''}`}>
      {icon !== 'none' && <Icon size={size === 'large' ? 15 : 12} className="countdown__icon" />}
      {showDate && <span className="countdown__date">{formatWhen(dueAt, locale, dict)}</span>}
      {!done && (
        <span
          className="countdown__clock mono"
          title={describeCountdown(dueAt, dict, now)}
          aria-label={describeCountdown(dueAt, dict, now)}
        >
          {parts.text}
        </span>
      )}
    </span>
  );
}

/** Just the ticking number, for tight spaces like the next-alarm bar. */
export function CountdownClock({ target, className }: { target: string | number; className?: string }) {
  const { dict } = useTranslation();
  const ms = typeof target === 'string' ? new Date(target).getTime() : target;
  const now = useNow(resolutionFor(ms));
  const parts = formatCountdown(ms, dict, now);
  if (!parts) return null;
  return (
    <span className={`mono ${className ?? ''} is-${parts.urgency}`} aria-live="off">
      {parts.text}
    </span>
  );
}
