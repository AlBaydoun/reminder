import { AnimatePresence, motion } from 'framer-motion';
import { Github, Info, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { api, IS_DEMO } from '../lib/api';
import { useTranslation } from '../store/ui';

const SOURCE_URL = 'https://github.com/AlBaydoun/reminder';
const DISMISS_KEY = 'nexus.demoNoticeSeen';

/**
 * Shown only in the published demo build. It says plainly where the data goes
 * and what the demo cannot do, rather than letting a visitor discover the
 * limits by losing something.
 */
export function DemoBanner() {
  const { dict } = useTranslation();
  const [open, setOpen] = useState(() => localStorage.getItem(DISMISS_KEY) !== 'true');
  const [resetting, setResetting] = useState(false);

  if (!IS_DEMO) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, 'true');
    setOpen(false);
  };

  const reset = async () => {
    if (!window.confirm(dict.demo.resetConfirm)) return;
    setResetting(true);
    await api.logout();
    window.location.reload();
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.aside
            className="demo-notice glass"
            role="status"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 240, damping: 26, delay: 0.5 }}
          >
            <Info size={18} className="demo-notice__icon" />
            <div className="grow">
              <strong>{dict.demo.title}</strong>
              <p className="muted">{dict.demo.body}</p>
              <div className="demo-notice__actions">
                <a className="btn btn-sm" href={SOURCE_URL} target="_blank" rel="noreferrer">
                  <Github size={14} />
                  {dict.demo.source}
                </a>
                <button className="btn btn-sm btn-ghost" onClick={() => void reset()} disabled={resetting}>
                  <RotateCcw size={14} />
                  {dict.demo.reset}
                </button>
                <button className="btn btn-sm btn-primary" onClick={dismiss}>
                  {dict.demo.dismiss}
                </button>
              </div>
            </div>
            <button className="toast__close" onClick={dismiss} aria-label={dict.common.close}>
              <X size={15} />
            </button>
          </motion.aside>
        )}
      </AnimatePresence>

      {!open && (
        <button className="demo-chip" onClick={() => setOpen(true)} title={dict.demo.title}>
          {dict.demo.badge}
        </button>
      )}
    </>
  );
}
