import { motion } from 'framer-motion';
import { BellRing, CheckCircle2, Download, ShieldAlert, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isAudioUnlocked, onAudioUnlock, unlockAudio } from '../lib/audio/player';
import { useAlarms } from '../store/alarms';
import { useTranslation } from '../store/ui';

const isInstalled = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true);

/**
 * Whether an alarm can actually reach you, stated plainly.
 *
 * Every one of these can silently stop an alarm being noticed, and a person
 * only finds out by missing something. Listing them — with the fix one tap
 * away — is the difference between an alarm clock you trust and one you check.
 */
export function AlarmHealth() {
  const { dict } = useTranslation();
  const notificationsGranted = useAlarms((s) => s.notificationsGranted);
  const requestNotifications = useAlarms((s) => s.requestNotifications);
  const [audioReady, setAudioReady] = useState(isAudioUnlocked);
  const [installed] = useState(isInstalled);

  useEffect(() => {
    const unsubscribe = onAudioUnlock(setAudioReady);
    return () => {
      unsubscribe();
    };
  }, []);

  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const allGood = notificationsGranted && audioReady;

  const Row = ({
    ok,
    icon,
    label,
    action,
  }: {
    ok: boolean;
    icon: React.ReactNode;
    label: string;
    action?: { text: string; run(): void };
  }) => (
    <div className={`health-row ${ok ? 'is-ok' : 'is-warn'}`}>
      <span className="health-row__icon">{icon}</span>
      <span className="grow">{label}</span>
      {!ok && action && (
        <button className="btn btn-sm btn-primary" onClick={action.run}>
          {action.text}
        </button>
      )}
      {ok && <CheckCircle2 size={16} className="health-row__tick" />}
    </div>
  );

  return (
    <motion.section
      className={`panel glass health ${allGood ? 'is-ready' : ''}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <header className="panel__head">
        {allGood ? <CheckCircle2 size={17} /> : <ShieldAlert size={17} />}
        <h2>{allGood ? dict.health.ready : dict.health.title}</h2>
      </header>

      <Row
        ok={notificationsGranted}
        icon={<BellRing size={16} />}
        label={notificationsGranted ? dict.health.notificationsOn : dict.health.notificationsOff}
        action={
          blocked
            ? undefined
            : {
                text: dict.reminder.permissionAllow,
                run: async () => {
                  await unlockAudio();
                  await requestNotifications();
                },
              }
        }
      />

      <Row
        ok={audioReady}
        icon={<Volume2 size={16} />}
        label={audioReady ? dict.health.soundOn : dict.health.soundOff}
        action={{ text: dict.reminder.audioUnlock, run: () => void unlockAudio() }}
      />

      <Row
        ok={installed}
        icon={<Download size={16} />}
        label={installed ? dict.health.installed : dict.health.notInstalled}
      />

      {/* Not a checkbox — a limitation of the platform, stated rather than hidden. */}
      <p className="faint health__caveat">{dict.health.tabOpen}</p>
    </motion.section>
  );
}
