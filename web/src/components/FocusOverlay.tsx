import { AnimatePresence, motion } from 'framer-motion';
import { Check, Pause, Play, Plus, X } from 'lucide-react';
import { useEffect } from 'react';
import { useNow } from '../lib/clock';
import { itemPath, useData } from '../store/data';
import { useFocusSession } from '../store/focusSession';
import { useTranslation } from '../store/ui';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * One task, full screen, counting down.
 *
 * The app's whole purpose is holding attention on a single thing, and that is
 * hard to do from a list — a list is a menu of everything you are not doing.
 * This removes the menu. Time is derived from the wall clock rather than
 * accumulated by a ticker, so the count stays true across a backgrounded tab,
 * a locked phone, or a reload.
 */
export function FocusOverlay() {
  const { dict } = useTranslation();
  const session = useFocusSession();
  const items = useData((s) => s.items);
  const loaded = useData((s) => s.loaded);
  const toggleComplete = useData((s) => s.toggleComplete);
  const now = useNow(1000);

  const item = items.find((i) => i.id === session.itemId);
  const elapsed = session.elapsed(now);
  const remaining = Math.max(0, session.totalMs - elapsed);
  const running = session.startedAt !== null;

  // Ending the session when the task itself is gone avoids an overlay you
  // cannot dismiss because the thing behind it no longer exists. This waits
  // for the first load: right after a reload the list is briefly empty, and
  // dropping the session then would throw away a timer that is still running.
  useEffect(() => {
    if (loaded && session.itemId && !item) session.stop();
  }, [loaded, session.itemId, item, session]);

  useEffect(() => {
    if (item && running && remaining <= 0 && !session.finished) session.markFinished(item.title);
  }, [item, running, remaining, session]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!session.itemId) return;
      if (event.key === 'Escape') session.stop();
      if (event.key === ' ' && (event.target as HTMLElement)?.tagName !== 'INPUT') {
        event.preventDefault();
        running ? session.pause() : session.resume();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session, running]);

  if (!session.itemId || !item) return null;

  const progress = session.totalMs > 0 ? Math.min(1, elapsed / session.totalMs) : 0;
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  const path = itemPath(items, item.id).slice(0, -1);

  const size = 300;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <AnimatePresence>
      <motion.div
        className="focus-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        role="dialog"
        aria-modal="true"
        aria-label={dict.focusSession.title}
      >
        <motion.div
          className="focus-overlay__panel"
          initial={{ scale: 0.94, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 220, damping: 24 }}
        >
          <button className="focus-overlay__close btn btn-ghost btn-icon" onClick={session.stop} aria-label={dict.focusSession.stop}>
            <X size={20} />
          </button>

          <p className="focus-overlay__label">{dict.focusSession.title}</p>
          {path.length > 0 && <p className="faint">{path.map((p) => p.title).join(' › ')}</p>}
          <h1 className="focus-overlay__title">
            {item.icon} {item.title}
          </h1>

          <div className="focus-overlay__ring" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
              <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--stroke)" strokeWidth={stroke} />
              <motion.circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={session.finished ? 'var(--ok)' : 'url(#focus-gradient)'}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference}
                initial={false}
                animate={{ strokeDashoffset: circumference * (1 - progress) }}
                transition={{ duration: 0.6, ease: 'linear' }}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
              <defs>
                <linearGradient id="focus-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--accent-2)" />
                </linearGradient>
              </defs>
            </svg>

            <div className="focus-overlay__clock">
              <span className="mono focus-overlay__time">
                {pad(minutes)}:{pad(seconds)}
              </span>
              <span className="faint">
                {dict.focusSession.elapsed} {Math.floor(elapsed / 60_000)}
                {dict.countdown.minute}
              </span>
            </div>
          </div>

          <div className="focus-overlay__actions">
            <button className="btn" onClick={() => (running ? session.pause() : session.resume())}>
              {running ? <Pause size={16} /> : <Play size={16} />}
              {running ? dict.focusSession.pause : dict.focusSession.resume}
            </button>
            <button className="btn" onClick={() => session.extend(5)}>
              <Plus size={16} />
              {dict.focusSession.minutes.replace('{n}', '5')}
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await toggleComplete(item.id, true);
                session.stop();
              }}
            >
              <Check size={16} />
              {dict.focusSession.finish}
            </button>
          </div>

          <p className="faint focus-overlay__hint">{dict.focusSession.hint}</p>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
