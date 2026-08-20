import { motion } from 'framer-motion';
import {
  Clock,
  Database,
  Download,
  HardDriveDownload,
  Languages,
  Palette,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  User,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SoundPicker } from '../components/SoundPicker';
import { Segmented, Spinner, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { formatBytes } from '../lib/text';
import { formatWhen } from '../lib/format';
import { LOCALES } from '../i18n';
import type { BackupRecord, Locale } from '../lib/types';
import { useAuth } from '../store/auth';
import { useData } from '../store/data';
import { useTranslation, useUi, type MotionLevel } from '../store/ui';

export function SettingsView() {
  const { dict, locale } = useTranslation();
  const ui = useUi();
  const user = useAuth((s) => s.user);
  const saveSettings = useAuth((s) => s.saveSettings);
  const saveProfile = useAuth((s) => s.saveProfile);
  const toast = useUi((s) => s.toast);
  const refresh = useData((s) => s.refresh);

  const [name, setName] = useState(user?.name ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [capacity, setCapacity] = useState(Number(user?.settings.dailyCapacityMinutes ?? 240));
  const [workStart, setWorkStart] = useState(Number(user?.settings.workStartHour ?? 9));
  const [workEnd, setWorkEnd] = useState(Number(user?.settings.workEndHour ?? 19));

  useEffect(() => {
    setName(user?.name ?? '');
    setTimezone(user?.timezone ?? 'UTC');
  }, [user?.name, user?.timezone]);

  const timezones =
    typeof Intl.supportedValuesOf === 'function'
      ? (Intl.supportedValuesOf('timeZone') as string[])
      : [timezone, 'UTC'];

  const Section = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
    <motion.section className="panel glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <header className="panel__head">
        {icon}
        <h2>{title}</h2>
      </header>
      <div className="stack" style={{ gap: 16 }}>
        {children}
      </div>
    </motion.section>
  );

  return (
    <div className="view view--settings">
      <header className="view__head">
        <h1 className="view__title">{dict.settings.title}</h1>
      </header>

      <Section icon={<User size={17} />} title={dict.settings.profile}>
        <div className="field">
          <label htmlFor="set-name">{dict.auth.name}</label>
          <input id="set-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="faint">{user?.email}</p>
        <button className="btn btn-primary" onClick={() => void saveProfile({ name })}>
          <Save size={15} />
          {dict.common.save}
        </button>
      </Section>

      <Section icon={<Palette size={17} />} title={dict.settings.appearance}>
        <div className="field">
          <label>
            <Languages size={12} /> {dict.settings.language}
          </label>
          <Segmented
            ariaLabel={dict.settings.language}
            value={locale}
            onChange={(next: Locale) => {
              ui.setLocale(next);
              void saveProfile({ locale: next });
            }}
            options={LOCALES.map((l) => ({ value: l.code, label: `${l.flag} ${l.native}` }))}
          />
        </div>

        <div className="field">
          <label>{dict.settings.theme}</label>
          <Segmented
            ariaLabel={dict.settings.theme}
            value={ui.theme}
            onChange={(next) => {
              ui.setTheme(next);
              void saveSettings({ theme: next });
            }}
            options={[
              { value: 'dark' as const, label: dict.settings.themeDark },
              { value: 'light' as const, label: dict.settings.themeLight },
            ]}
          />
        </div>

        <div className="field">
          <label>{dict.settings.motion}</label>
          <Segmented
            ariaLabel={dict.settings.motion}
            value={ui.motion}
            onChange={(next: MotionLevel) => {
              ui.setMotion(next);
              void saveSettings({ motion: next });
            }}
            options={[
              { value: 'full' as const, label: dict.settings.motionFull },
              { value: 'balanced' as const, label: dict.settings.motionBalanced },
              { value: 'calm' as const, label: dict.settings.motionCalm },
            ]}
          />
          <p className="faint">{dict.settings.motionHint}</p>
        </div>
      </Section>

      <Section icon={<Clock size={17} />} title={dict.settings.schedule}>
        <div className="field">
          <label htmlFor="set-tz">{dict.settings.timezone}</label>
          <select
            id="set-tz"
            className="select"
            value={timezone}
            onChange={(event) => {
              setTimezone(event.target.value);
              void saveProfile({ timezone: event.target.value });
            }}
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p className="faint">{dict.settings.timezoneHint}</p>
        </div>

        <div className="row" style={{ gap: 12 }}>
          <div className="field grow">
            <label htmlFor="set-start">{dict.settings.workStart}</label>
            <input
              id="set-start"
              type="number"
              min={0}
              max={23}
              className="input"
              value={workStart}
              onChange={(e) => setWorkStart(Number(e.target.value))}
              onBlur={() => void saveSettings({ workStartHour: workStart })}
            />
          </div>
          <div className="field grow">
            <label htmlFor="set-end">{dict.settings.workEnd}</label>
            <input
              id="set-end"
              type="number"
              min={1}
              max={24}
              className="input"
              value={workEnd}
              onChange={(e) => setWorkEnd(Number(e.target.value))}
              onBlur={() => void saveSettings({ workEndHour: workEnd })}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="set-capacity">
            {dict.settings.capacity} — {Math.round((capacity / 60) * 10) / 10} h
          </label>
          <input
            id="set-capacity"
            type="range"
            min={30}
            max={720}
            step={15}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
            onMouseUp={() => void saveSettings({ dailyCapacityMinutes: capacity })}
            onTouchEnd={() => void saveSettings({ dailyCapacityMinutes: capacity })}
          />
          <p className="faint">{dict.settings.capacityHint}</p>
        </div>
      </Section>

      <Section icon={<Save size={17} />} title={dict.voice.title}>
        <Toggle
          checked={Boolean(user?.settings.voiceAutoApply)}
          onChange={(next) => void saveSettings({ voiceAutoApply: next })}
          label={dict.voice.autoApply}
        />
        <Toggle
          checked={Boolean(user?.settings.voiceContinuous)}
          onChange={(next) => void saveSettings({ voiceContinuous: next })}
          label={dict.voice.continuous}
        />
        <div className="field">
          <label>{dict.voice.language}</label>
          <Segmented
            ariaLabel={dict.voice.language}
            value={(user?.settings.voiceLocale as Locale) ?? locale}
            onChange={(next: Locale) => void saveSettings({ voiceLocale: next })}
            options={LOCALES.map((l) => ({ value: l.code, label: `${l.flag} ${l.native}` }))}
          />
        </div>
      </Section>

      <Section icon={<Database size={17} />} title={dict.settings.defaultSound}>
        <SoundPicker
          value={(user?.settings.defaultSoundId as string) ?? null}
          onChange={(soundId) => void saveSettings({ defaultSoundId: soundId ?? undefined })}
        />
      </Section>

      <BackupPanel onRestored={() => void refresh()} />
    </div>
  );
}

function BackupPanel({ onRestored }: { onRestored(): void }) {
  const { dict, locale } = useTranslation();
  const toast = useUi((s) => s.toast);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [lastNightly, setLastNightly] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const data = await api.listBackups();
      setBackups(data.backups);
      setLastNightly(data.lastNightly);
    } catch {
      /* the panel simply shows nothing */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  async function run<T>(work: () => Promise<T>, successMessage?: string) {
    setBusy(true);
    try {
      const result = await work();
      if (successMessage) toast(successMessage, 'success');
      await load();
      return result;
    } catch (error) {
      toast((error as Error).message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.section className="panel glass" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <header className="panel__head">
        <HardDriveDownload size={17} />
        <h2>{dict.backup.title}</h2>
      </header>

      <p className="muted">{dict.backup.subtitle}</p>
      <p className="faint">
        {lastNightly
          ? dict.backup.lastBackup.replace('{when}', formatWhen(lastNightly, locale, dict))
          : dict.backup.never}
      </p>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={() => void run(() => api.createBackup(), dict.backup.created)}>
          {busy ? <Spinner size={14} /> : <Save size={15} />}
          {dict.backup.createNow}
        </button>
        <a className="btn" href={api.exportUrl()} download>
          <Download size={15} />
          {dict.backup.exportNow}
        </a>
        <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload size={15} />
          {dict.backup.import}
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => void run(() => api.runNightlyBackup(), dict.backup.created)}
        >
          <RotateCcw size={15} />
          {dict.backup.runNightly}
        </button>
        <Segmented<'replace' | 'merge'>
          ariaLabel={dict.backup.restore}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'replace' as const, label: dict.backup.modeReplace },
            { value: 'merge' as const, label: dict.backup.modeMerge },
          ]}
        />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const result = await run(() => api.importBackup(file, mode));
          if (result) {
            onRestored();
            toast(
              dict.backup.restored
                .replace('{items}', String(result.restored.items ?? 0))
                .replace('{reminders}', String(result.restored.reminders ?? 0))
                .replace('{drawings}', String(result.restored.drawings ?? 0)),
              'success',
            );
          }
          if (fileInput.current) fileInput.current.value = '';
        }}
      />

      <div className="backup-list">
        {backups.map((backup) => (
          <div key={backup.id} className="backup-row">
            <span className={`chip chip--tiny ${backup.kind === 'nightly' ? 'is-active' : ''}`}>
              {backup.kind === 'nightly'
                ? dict.backup.nightly
                : backup.kind === 'manual'
                  ? dict.backup.manual
                  : dict.backup.preRestore}
            </span>
            <span className="grow truncate">{formatWhen(backup.createdAt, locale, dict)}</span>
            <span className="faint mono">
              {backup.itemCount} · {formatBytes(backup.size)}
            </span>
            {backup.available ? (
              <>
                <a className="btn btn-sm btn-ghost" href={api.backupDownloadUrl(backup.id)} download>
                  <Download size={14} />
                </a>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        dict.backup.restoreConfirm.replace('{when}', formatWhen(backup.createdAt, locale, dict)),
                      )
                    )
                      return;
                    const result = await run(() => api.restoreBackup(backup.id, mode));
                    if (result) {
                      onRestored();
                      toast(
                        dict.backup.restored
                          .replace('{items}', String(result.restored.items ?? 0))
                          .replace('{reminders}', String(result.restored.reminders ?? 0))
                          .replace('{drawings}', String(result.restored.drawings ?? 0)),
                        'success',
                      );
                    }
                  }}
                >
                  {dict.backup.restore}
                </button>
              </>
            ) : (
              <span className="faint">{dict.backup.missing}</span>
            )}
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => void run(() => api.deleteBackup(backup.id))}
              aria-label={dict.common.delete}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </motion.section>
  );
}
