import { AnimatePresence, motion } from 'framer-motion';
import { CloudOff, RefreshCw, UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { offlineState, onOfflineChange, type OfflineState } from '../lib/offline';
import { useTranslation } from '../store/ui';

/**
 * What the app is doing about the network, said plainly.
 *
 * Silence here is the worst option. Someone who writes three tasks on a train
 * needs to know they are safe and not yet sent — and someone whose changes
 * have just gone through should see that too, once, rather than wondering.
 * The bar shows itself only when there is something to say.
 */
export function ConnectionBar() {
  const { dict } = useTranslation();
  const [state, setState] = useState<OfflineState>(offlineState);
  const [justSynced, setJustSynced] = useState(false);

  useEffect(() => {
    const unsubscribe = onOfflineChange(setState);
    return () => void unsubscribe();
  }, []);

  // A brief confirmation as the last queued change lands, then out of the way.
  useEffect(() => {
    if (state.online && state.pending === 0 && !state.syncing) return;
    if (!state.online || state.pending > 0) {
      setJustSynced(true);
      return;
    }
  }, [state.online, state.pending, state.syncing]);

  useEffect(() => {
    if (!justSynced || !state.online || state.pending > 0 || state.syncing) return;
    const timer = window.setTimeout(() => setJustSynced(false), 2600);
    return () => window.clearTimeout(timer);
  }, [justSynced, state.online, state.pending, state.syncing]);

  const offline = !state.online;
  const queued = state.pending > 0;
  const settled = justSynced && state.online && !queued && !state.syncing;
  const visible = offline || queued || state.syncing || settled;

  const tone = offline ? 'is-offline' : state.syncing || queued ? 'is-syncing' : 'is-ok';
  const label = offline
    ? queued
      ? dict.connection.offlineWithChanges.replace('{n}', String(state.pending))
      : dict.connection.offline
    : state.syncing
      ? dict.connection.syncing
      : queued
        ? dict.connection.queued.replace('{n}', String(state.pending))
        : dict.connection.synced;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={`connection-bar ${tone}`}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        >
          {offline ? (
            <CloudOff size={14} />
          ) : state.syncing ? (
            <RefreshCw size={14} className="spin" />
          ) : (
            <UploadCloud size={14} />
          )}
          <span className="connection-bar__label">{label}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
