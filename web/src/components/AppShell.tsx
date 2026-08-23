import { motion } from 'framer-motion';
import {
  Activity,
  AlarmClock,
  CalendarRange,
  FolderTree,
  LogOut,
  Mic,
  Moon,
  Orbit,
  PenLine,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Sunrise,
  Target,
  Trash2,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api, IS_DEMO } from '../lib/api';
import { unlockAudio, isAudioUnlocked } from '../lib/audio/player';
import { useAlarms } from '../store/alarms';
import { useAuth } from '../store/auth';
import { useTranslation, useUi } from '../store/ui';
import { AuroraBackground } from './AuroraBackground';
import { ConnectionBar } from './ConnectionBar';
import { NextAlarmBar } from './NextAlarmBar';

interface NavEntry {
  to: string;
  icon: typeof Sunrise;
  key: keyof typeof NAV_KEYS;
  /** Only the root route needs exact matching, or it stays highlighted everywhere. */
  end?: boolean;
}

const NAV_KEYS = {
  today: 1, galaxy: 1, list: 1, focus: 1, timeline: 1, alarms: 1, canvas: 1, insights: 1,
} as const;

const NAV: NavEntry[] = [
  { to: '/', icon: Sunrise, key: 'today', end: true },
  { to: '/galaxy', icon: Orbit, key: 'galaxy' },
  { to: '/list', icon: FolderTree, key: 'list' },
  { to: '/focus', icon: Target, key: 'focus' },
  { to: '/timeline', icon: CalendarRange, key: 'timeline' },
  { to: '/alarms', icon: AlarmClock, key: 'alarms' },
  { to: '/draw', icon: PenLine, key: 'canvas' },
  { to: '/insights', icon: Activity, key: 'insights' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { dict } = useTranslation();
  const ui = useUi();
  const location = useLocation();
  const signOut = useAuth((s) => s.signOut);
  const ringingCount = useAlarms((s) => s.ringing.length);
  const armedCount = useAlarms((s) => s.armed.length);

  // Ctrl/Cmd-K opens search, Ctrl/Cmd-J starts voice.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ui.setCommandPalette(!ui.commandPaletteOpen);
      }
      if (meta && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        void unlockAudio();
        ui.setVoiceOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui]);

  return (
    <div className="shell">
      <AuroraBackground />

      <nav className="rail glass" aria-label={dict.app.name}>
        <div className="rail__brand" title={dict.app.tagline}>
          <span className="rail__logo">◈</span>
        </div>

        <div className="rail__items">
          {NAV.map(({ to, icon: Icon, key, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `rail__item ${isActive ? 'is-active' : ''}`}
              title={dict.nav[key as keyof typeof dict.nav]}
            >
              {location.pathname === to && (
                <motion.span layoutId="rail-active" className="rail__active" transition={{ type: 'spring', stiffness: 350, damping: 30 }} />
              )}
              <Icon size={20} />
              <span className="rail__label">{dict.nav[key as keyof typeof dict.nav]}</span>
              {key === 'alarms' && armedCount > 0 && <span className="rail__badge mono">{armedCount}</span>}
            </NavLink>
          ))}
        </div>

        <div className="rail__footer">
          <NavLink to="/trash" className={({ isActive }) => `rail__item ${isActive ? 'is-active' : ''}`} title={dict.nav.trash}>
            <Trash2 size={19} />
            <span className="rail__label">{dict.nav.trash}</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `rail__item ${isActive ? 'is-active' : ''}`} title={dict.nav.settings}>
            <Settings size={19} />
            <span className="rail__label">{dict.nav.settings}</span>
          </NavLink>
          {IS_DEMO ? (
            <button
              className="rail__item"
              title={dict.demo.reset}
              onClick={async () => {
                if (!window.confirm(dict.demo.resetConfirm)) return;
                await api.logout();
                window.location.reload();
              }}
            >
              <RotateCcw size={19} />
              <span className="rail__label">{dict.demo.reset}</span>
            </button>
          ) : (
            <button className="rail__item" onClick={() => void signOut()} title={dict.nav.signOut}>
              <LogOut size={19} />
              <span className="rail__label">{dict.nav.signOut}</span>
            </button>
          )}
        </div>
      </nav>

      <div className="shell__main">
        <header className="topbar">
          <button className="topbar__search glass" onClick={() => ui.setCommandPalette(true)}>
            <Search size={16} />
            <span className="grow truncate faint">{dict.common.searchPlaceholder}</span>
            <kbd className="palette__kbd">⌘K</kbd>
          </button>

          <ConnectionBar />
          <NextAlarmBar />

          <button
            className="btn btn-icon"
            onClick={() => ui.setTheme(ui.theme === 'dark' ? 'light' : 'dark')}
            aria-label={dict.settings.theme}
          >
            {ui.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          <motion.button
            className={`voice-fab ${ringingCount > 0 ? 'is-muted' : ''}`}
            onClick={async () => {
              await unlockAudio();
              ui.setVoiceOpen(true);
            }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.94 }}
            aria-label={dict.voice.tapToSpeak}
            title={`${dict.voice.tapToSpeak} (⌘J)`}
          >
            <Mic size={19} />
          </motion.button>
        </header>

        <main className="shell__content">{children}</main>
      </div>

      <nav className="tabbar glass" aria-label={dict.app.name}>
        {NAV.slice(0, 5).map(({ to, icon: Icon, key, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `tabbar__item ${isActive ? 'is-active' : ''}`}
          >
            <Icon size={20} />
            <span>{dict.nav[key as keyof typeof dict.nav]}</span>
          </NavLink>
        ))}
      </nav>

      {!isAudioUnlocked() && <AudioUnlockPrompt />}
    </div>
  );
}

/**
 * Browsers refuse to play audio before the page has been interacted with, so
 * an alarm set now could ring silently later. One tap fixes it, and saying so
 * plainly is better than a silent failure at 6 a.m.
 */
function AudioUnlockPrompt() {
  const { dict } = useTranslation();
  const requestNotifications = useAlarms((s) => s.requestNotifications);

  return (
    <motion.div
      className="audio-unlock glass"
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 1.2, type: 'spring', stiffness: 220, damping: 24 }}
    >
      <div className="grow">
        <strong>{dict.reminder.audioUnlockTitle}</strong>
        <p className="muted">{dict.reminder.audioUnlockBody}</p>
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={async () => {
          await unlockAudio();
          await requestNotifications();
        }}
      >
        {dict.reminder.audioUnlock}
      </button>
    </motion.div>
  );
}
