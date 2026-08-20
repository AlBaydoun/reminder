import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { useUi } from '../store/ui';

/** Ring that fills clockwise — used for category completion everywhere. */
export function ProgressRing({
  value,
  size = 34,
  stroke = 3,
  color,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: ReactNode;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));

  return (
    <div className="progress-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--stroke)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={clamped >= 1 ? 'var(--ok)' : (color ?? 'var(--accent)')}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={false}
          animate={{ strokeDashoffset: circumference * (1 - clamped) }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children && <div className="progress-ring__center">{children}</div>}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 9) }}
      role="status"
      aria-live="polite"
    />
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <motion.div
      className="empty-state"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="empty-state__icon">{icon}</div>
      <p className="empty-state__title">{title}</p>
      {hint && <p className="empty-state__hint muted">{hint}</p>}
      {action}
    </motion.div>
  );
}

/**
 * Modal dialog. Traps nothing fancy, but does the three things that matter:
 * closes on Escape, restores focus, and never lets the backdrop scroll the
 * page behind it.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose(): void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const timer = window.setTimeout(() => panelRef.current?.focus(), 40);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            className="modal glass"
            style={{ maxWidth: width }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? labelId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, y: 28, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          >
            {title && (
              <header className="modal__head">
                <h2 id={labelId}>{title}</h2>
                <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
                  <X size={18} />
                </button>
              </header>
            )}
            <div className="modal__body">{children}</div>
            {footer && <footer className="modal__foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Bottom sheet on phones, side drawer on wide screens. */
export function Drawer({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  title?: ReactNode;
}) {
  const dir = useUi((s) => s.dir);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const offscreen = dir === 'rtl' ? -420 : 420;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="drawer-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="drawer glass"
            role="dialog"
            aria-modal="true"
            initial={{ x: offscreen, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: offscreen, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
          >
            <header className="drawer__head">
              <div className="grow truncate">{title}</div>
              <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
                <X size={18} />
              </button>
            </header>
            <div className="drawer__body">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange(value: T): void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          title={option.title}
          aria-selected={value === option.value}
          className={`segmented__item ${value === option.value ? 'is-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {value === option.value && (
            <motion.span layoutId={`segmented-${ariaLabel ?? 'group'}`} className="segmented__pill" />
          )}
          <span className="segmented__label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="toggle">
      <span className="grow">
        <span className="toggle__label">{label}</span>
        {hint && <span className="toggle__hint muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle__track ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <motion.span layout className="toggle__thumb" transition={{ type: 'spring', stiffness: 500, damping: 32 }} />
      </button>
    </label>
  );
}

/**
 * A burst of particles when something is completed. Deliberately cheap:
 * transform-only animation on a handful of absolutely positioned dots, and it
 * unmounts itself when finished.
 */
export function Confetti({ x, y, color = 'var(--accent)' }: { x: number; y: number; color?: string }) {
  const effects = useUi((s) => s.effects);
  const pieces = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        angle: (i / 16) * Math.PI * 2 + Math.random() * 0.4,
        distance: 40 + Math.random() * 70,
        size: 4 + Math.random() * 5,
        delay: Math.random() * 0.06,
      })),
    [],
  );
  if (!effects.particles) return null;

  return (
    <div className="confetti" style={{ left: x, top: y }} aria-hidden>
      {pieces.map((piece, index) => (
        <motion.span
          key={index}
          style={{ width: piece.size, height: piece.size, background: color }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{
            x: Math.cos(piece.angle) * piece.distance,
            y: Math.sin(piece.angle) * piece.distance + 30,
            opacity: 0,
            scale: 0.4,
          }}
          transition={{ duration: 0.85, delay: piece.delay, ease: [0.16, 1, 0.3, 1] }}
        />
      ))}
    </div>
  );
}
