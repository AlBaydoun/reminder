import { Music4, Play, Smartphone, Square, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { playSound, unlockAudio, type PlayHandle } from '../lib/audio/player';
import { formatBytes } from '../lib/text';
import {
  deviceSoundId,
  deviceSoundKind,
  deviceSoundsAvailable,
  isDeviceSound,
  pickDeviceSound,
  previewDeviceSound,
  stopDeviceSoundPreview,
} from '../lib/native/deviceSounds';
import { useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

/**
 * Choose an alarm tone.
 *
 * Three sources, in order of how directly they answer "a sound from inside the
 * phone": the synthesized built-ins, a sound taken straight off the device,
 * and an uploaded file. The middle one only exists in the phone builds — a
 * browser cannot read the ringtones a phone already has, and the file input it
 * does offer is the nearest thing it can do.
 */
export function SoundPicker({
  value,
  onChange,
  volume = 0.9,
}: {
  value: string | null;
  onChange(soundId: string | null): void;
  volume?: number;
}) {
  const { dict } = useTranslation();
  const toast = useUi((s) => s.toast);
  const builtin = useData((s) => s.builtinSounds);
  const custom = useData((s) => s.customSounds);
  const refreshSounds = useData((s) => s.refreshSounds);

  const [previewing, setPreviewing] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // The name the phone gave the picked sound; a content URI is unreadable.
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const handle = useRef<PlayHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!builtin.length) void refreshSounds();
    return () => handle.current?.stop();
  }, [builtin.length, refreshSounds]);

  async function preview(soundId: string) {
    handle.current?.stop();
    void stopDeviceSoundPreview();
    if (previewing === soundId) {
      setPreviewing(null);
      return;
    }

    // A sound owned by the phone can only be played by the phone: the web
    // layer has no readable URL for a content:// URI or a file in the app's
    // own Sounds directory.
    if (isDeviceSound(soundId)) {
      const played = await previewDeviceSound(soundId);
      if (!played) {
        toast(dict.reminder.deviceSoundUnavailable, 'error');
        return;
      }
      setPreviewing(soundId);
      window.setTimeout(() => setPreviewing((c) => (c === soundId ? null : c)), 4000);
      return;
    }

    await unlockAudio();
    handle.current = playSound(soundId, { volume, loop: false });
    setPreviewing(soundId);
    window.setTimeout(() => setPreviewing((current) => (current === soundId ? null : current)), 4000);
  }

  async function pickFromPhone() {
    const picked = await pickDeviceSound(value);
    if (picked.cancelled || !picked.uri) return;
    setDeviceName(picked.name ?? null);
    onChange(deviceSoundId(picked.uri));
    toast(dict.reminder.deviceSoundPicked, 'success');
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const sound = await api.uploadSound(file, file.name.replace(/\.[^.]+$/, ''));
      await refreshSounds();
      onChange(sound.id);
      toast(dict.reminder.soundUploaded, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const Row = ({ id, name, meta }: { id: string; name: string; meta?: string }) => (
    <div className={`sound-row ${value === id ? 'is-active' : ''}`}>
      <button className="sound-row__pick grow" onClick={() => onChange(id)}>
        <span className="sound-row__radio" aria-hidden />
        <span className="grow truncate">{name}</span>
        {meta && <span className="faint mono">{meta}</span>}
      </button>
      <button
        className="btn btn-ghost btn-icon btn-sm"
        onClick={() => void preview(id)}
        aria-label={dict.reminder.preview}
      >
        {previewing === id ? <Square size={14} /> : <Play size={14} />}
      </button>
      {!id.startsWith('builtin:') && (
        <button
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={dict.common.delete}
          onClick={async () => {
            await api.deleteSound(id);
            if (value === id) onChange(null);
            await refreshSounds();
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );

  return (
    <div className="sound-picker">
      <p className="sound-picker__group faint">{dict.reminder.builtinSounds}</p>
      <div className="sound-picker__list">
        {builtin.map((sound) => (
          <Row key={sound.key} id={`builtin:${sound.key}`} name={sound.name} meta={sound.character} />
        ))}
      </div>

      {deviceSoundsAvailable() && (
        <>
          <p className="sound-picker__group faint">{dict.reminder.deviceSound}</p>
          <div className="sound-picker__list">
            {isDeviceSound(value) && (
              <Row
                id={value as string}
                name={deviceName ?? dict.reminder.deviceSound}
                meta={deviceSoundKind() === 'ringtones' ? 'ringtone' : 'file'}
              />
            )}
          </div>
          <button className="btn" onClick={() => void pickFromPhone()}>
            <Smartphone size={15} />
            {dict.reminder.pickDeviceSound}
          </button>
        </>
      )}

      <p className="sound-picker__group faint">{dict.reminder.customSounds}</p>
      <div className="sound-picker__list">
        {custom.map((sound) => (
          <Row key={sound.id} id={sound.id} name={sound.name} meta={formatBytes(sound.size)} />
        ))}
        {custom.length === 0 && <p className="muted sound-picker__empty">{dict.reminder.uploadHint}</p>}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
        {uploading ? <Music4 size={15} /> : <Upload size={15} />}
        {dict.reminder.uploadSound}
      </button>
    </div>
  );
}
