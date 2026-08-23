import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';
import { onSynced } from './lib/offline';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AlarmOverlay } from './components/AlarmOverlay';
import { AppShell } from './components/AppShell';
import { AuthScreen } from './components/AuthScreen';
import { CommandPalette } from './components/CommandPalette';
import { DemoBanner } from './components/DemoBanner';
import { FocusOverlay } from './components/FocusOverlay';
import { ItemDetail } from './components/ItemDetail';
import { Toasts } from './components/Toasts';
import { VoicePanel } from './components/VoicePanel';
import { Spinner } from './components/ui';
import { useAlarms } from './store/alarms';
import { useAuth } from './store/auth';
import { useData } from './store/data';
import { useUi } from './store/ui';
import { AlarmsView } from './views/AlarmsView';
import { CanvasView } from './views/CanvasView';
import { FocusView } from './views/FocusView';
import { PlanView } from './views/PlanView';
import { GalaxyView } from './views/GalaxyView';
import { InsightsView } from './views/InsightsView';
import { ListView } from './views/ListView';
import { SettingsView } from './views/SettingsView';
import { TimelineView } from './views/TimelineView';
import { TodayView } from './views/TodayView';
import { TrashView } from './views/TrashView';

/** Cross-fades between views without remounting the shell around them. */
function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={{ height: '100%' }}
      >
        <Routes location={location}>
          <Route path="/" element={<TodayView />} />
          <Route path="/galaxy" element={<GalaxyView />} />
          <Route path="/list" element={<ListView />} />
          <Route path="/plan" element={<PlanView />} />
          <Route path="/focus" element={<FocusView />} />
          <Route path="/timeline" element={<TimelineView />} />
          <Route path="/alarms" element={<AlarmsView />} />
          <Route path="/draw" element={<CanvasView />} />
          <Route path="/insights" element={<InsightsView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/trash" element={<TrashView />} />
          <Route path="*" element={<TodayView />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

function SignedInApp() {
  const refresh = useData((s) => s.refresh);
  const refreshSounds = useData((s) => s.refreshSounds);
  const startAlarms = useAlarms((s) => s.start);
  const stopAlarms = useAlarms((s) => s.stop);
  const loaded = useData((s) => s.loaded);

  useEffect(() => {
    void refresh();
    void refreshSounds();
    startAlarms();
    // Changes made offline reach the server on their own; the workspace has to
    // be reloaded afterwards so the interface stops showing temporary ids.
    const unsubscribe = onSynced(() => void refresh({ silent: true }));
    return () => {
      unsubscribe();
      stopAlarms();
    };
  }, [refresh, refreshSounds, startAlarms, stopAlarms]);

  // Bring the workspace back in sync after the tab has been in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AppShell>{loaded ? <AnimatedRoutes /> : <CenteredSpinner />}</AppShell>
      <ItemDetail />
      <CommandPalette />
      <VoicePanel />
    </BrowserRouter>
  );
}

function CenteredSpinner() {
  return (
    <div className="centered-spinner">
      <Spinner size={28} />
    </div>
  );
}

export default function App() {
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const dict = useUi((s) => s.dict);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <>
      {status === 'unknown' && (
        <div className="boot">
          <span className="boot__logo">◈</span>
          <p className="shimmer-text">{dict.app.name}</p>
        </div>
      )}
      {status === 'signed-out' && <AuthScreen />}
      {status === 'signed-in' && <SignedInApp />}

      {status === 'signed-in' && <FocusOverlay />}
      <AlarmOverlay />
      <DemoBanner />
      <Toasts />
    </>
  );
}
