import { AnimatePresence, motion } from 'framer-motion';
import { Check, Mic, MicOff, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatWhen } from '../lib/format';
import { LOCALES } from '../i18n';
import type { Locale } from '../lib/types';
import { useVoice } from '../store/voice';
import { useTranslation, useUi } from '../store/ui';
import { Modal, Spinner } from './ui';

/** Animated waveform that reacts to the phase, not to real audio levels —
 *  reading the microphone stream just to draw bars would cost battery for
 *  decoration. */
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="waveform" aria-hidden>
      {Array.from({ length: 28 }, (_, i) => (
        <motion.span
          key={i}
          animate={
            active
              ? { scaleY: [0.25, 0.4 + Math.random() * 1.4, 0.3], opacity: 1 }
              : { scaleY: 0.18, opacity: 0.35 }
          }
          transition={
            active
              ? { duration: 0.5 + Math.random() * 0.5, repeat: Infinity, repeatType: 'mirror', delay: i * 0.02 }
              : { duration: 0.3 }
          }
        />
      ))}
    </div>
  );
}

export function VoicePanel() {
  const { dict, locale } = useTranslation();
  const open = useUi((s) => s.voiceOpen);
  const setOpen = useUi((s) => s.setVoiceOpen);
  const voice = useVoice();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open && voice.phase === 'idle' && voice.supported) voice.startListening();
    if (!open) voice.cancel();
    // Starting on open is the whole point of the panel; re-running on every
    // phase change would restart recognition in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    voice.cancel();
    setOpen(false);
  };

  const listening = voice.phase === 'listening';
  const activeLocale = (voice.voiceLocale ?? locale) as Locale;

  return (
    <Modal open={open} onClose={close} title={dict.voice.title} width={640}>
      <div className="voice-panel">
        <div className="voice-panel__lang">
          {LOCALES.map((meta) => (
            <button
              key={meta.code}
              className={`chip chip--action ${activeLocale === meta.code ? 'is-active' : ''}`}
              onClick={() => voice.setVoiceLocale(meta.code)}
            >
              {meta.flag} {meta.native}
            </button>
          ))}
        </div>

        <motion.button
          className={`voice-orb ${listening ? 'is-listening' : ''}`}
          onClick={() => (listening ? voice.stopListening() : voice.startListening())}
          whileTap={{ scale: 0.94 }}
          aria-label={listening ? dict.common.close : dict.voice.tapToSpeak}
          disabled={!voice.supported}
        >
          <span className="voice-orb__glow" />
          {listening ? <Mic size={30} /> : voice.supported ? <Mic size={30} /> : <MicOff size={30} />}
        </motion.button>

        <Waveform active={listening} />

        <p className="voice-panel__status">
          {voice.phase === 'listening' && dict.voice.listening}
          {voice.phase === 'parsing' && dict.voice.thinking}
          {voice.phase === 'applying' && <Spinner size={16} />}
          {voice.phase === 'error' && <span className="voice-panel__error">{voice.error}</span>}
        </p>

        {(voice.transcript || voice.interim) && (
          <p className="voice-panel__transcript">
            <span className="faint">{dict.voice.heard}: </span>
            {voice.transcript} <span className="faint">{voice.interim}</span>
          </p>
        )}

        <AnimatePresence>
          {voice.commands.length > 0 && (
            <motion.div
              className="voice-plan"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <p className="voice-plan__title faint">{dict.voice.confirmTitle}</p>
              {voice.commands.map((command, index) => (
                <div key={index} className={`voice-plan__row ${command.problem ? 'has-problem' : ''}`}>
                  <span className="voice-plan__intent chip chip--tiny">{command.intent}</span>
                  <span className="grow">
                    {command.summary.title ?? command.summary.targetLabel ?? command.summary.query ?? '—'}
                    {command.summary.parentLabel && <span className="faint"> › {command.summary.parentLabel}</span>}
                    {command.summary.createsPath && (
                      <span className="faint"> › {command.summary.createsPath.join(' › ')} ＋</span>
                    )}
                    {command.summary.when && (
                      <span className="chip chip--tiny">{formatWhen(command.summary.when, locale, dict)}</span>
                    )}
                  </span>
                  <span className="faint mono">{Math.round(command.confidence * 100)}%</span>
                </div>
              ))}

              <div className="voice-plan__actions">
                <button className="btn btn-ghost" onClick={close}>
                  <X size={15} />
                  {dict.common.cancel}
                </button>
                <button className="btn btn-primary" onClick={() => void voice.apply()}>
                  <Check size={15} />
                  {dict.voice.confirmApply}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="voice-panel__typed">
          <input
            className="input grow"
            placeholder={dict.item.titlePlaceholder}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && typed.trim()) {
                voice.submitText(typed.trim());
                setTyped('');
              }
            }}
          />
          <button
            className="btn btn-icon"
            disabled={!typed.trim()}
            onClick={() => {
              voice.submitText(typed.trim());
              setTyped('');
            }}
            aria-label={dict.common.add}
          >
            <Send size={16} />
          </button>
        </div>

        <details className="voice-panel__examples">
          <summary className="faint">{dict.voice.examplesTitle}</summary>
          <ul>
            {dict.voice.examples.map((example) => (
              <li key={example}>
                <button className="voice-example" onClick={() => voice.submitText(example)}>
                  “{example}”
                </button>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Modal>
  );
}
