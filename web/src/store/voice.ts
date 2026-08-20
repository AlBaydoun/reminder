import { create } from 'zustand';
import { api } from '../lib/api';
import { playCue } from '../lib/audio/player';
import { parseUtterance, type ParsedCommand } from '../lib/nlp/command';
import { SpeechController, isSpeechSupported, type SpeechErrorKind } from '../lib/speech';
import type { Locale } from '../lib/types';
import { useAuth } from './auth';
import { useData } from './data';
import { useUi } from './ui';

export type VoicePhase = 'idle' | 'listening' | 'parsing' | 'confirming' | 'applying' | 'done' | 'error';

interface VoiceState {
  supported: boolean;
  phase: VoicePhase;
  interim: string;
  transcript: string;
  commands: ParsedCommand[];
  error: string | null;
  lastUndoId: string | null;
  voiceLocale: Locale | null;

  setVoiceLocale(locale: Locale | null): void;
  startListening(): void;
  stopListening(): void;
  cancel(): void;
  /** Parse typed text through the same pipeline as speech. */
  submitText(text: string): void;
  apply(): Promise<void>;
  undoLast(): Promise<void>;
}

let controller: SpeechController | null = null;

/** Voice can use a different language from the interface. */
function activeLocale(state: VoiceState): Locale {
  return state.voiceLocale ?? useAuth.getState().user?.settings.voiceLocale ?? useUi.getState().locale;
}

export const useVoice = create<VoiceState>((set, get) => ({
  supported: isSpeechSupported(),
  phase: 'idle',
  interim: '',
  transcript: '',
  commands: [],
  error: null,
  lastUndoId: null,
  voiceLocale: null,

  setVoiceLocale(locale) {
    set({ voiceLocale: locale });
    if (locale) void useAuth.getState().saveSettings({ voiceLocale: locale });
  },

  startListening() {
    const ui = useUi.getState();
    if (!get().supported) {
      set({ phase: 'error', error: ui.t('voice.unsupported') });
      return;
    }

    set({ phase: 'listening', interim: '', transcript: '', commands: [], error: null });
    playCue('listen');

    const continuous = Boolean(useAuth.getState().user?.settings.voiceContinuous);

    controller = new SpeechController({
      onInterim: (text) => set({ interim: text }),
      onFinal: (text) => {
        const previous = get().transcript;
        // In continuous mode the user may pause mid-sentence; keep appending.
        const combined = previous ? `${previous} ${text}`.trim() : text;
        set({ transcript: combined, interim: '' });
        if (!continuous) {
          controller?.stop();
          handleTranscript(combined, set, get);
        }
      },
      onEnd: () => {
        const { transcript, phase } = get();
        if (phase === 'listening') {
          if (transcript) handleTranscript(transcript, set, get);
          else set({ phase: 'idle' });
        }
      },
      onError: (kind: SpeechErrorKind) => {
        const messages: Record<SpeechErrorKind, string> = {
          denied: ui.t('voice.micDenied'),
          'no-speech': ui.t('voice.nothingHeard'),
          network: ui.t('error.offline'),
          unsupported: ui.t('voice.unsupported'),
          aborted: '',
          other: ui.t('error.generic'),
        };
        const message = messages[kind];
        if (kind === 'aborted') {
          set({ phase: 'idle' });
          return;
        }
        set({ phase: 'error', error: message });
        playCue('error');
      },
    });

    controller.start(activeLocale(get()), continuous);
  },

  stopListening() {
    controller?.stop();
    const { transcript } = get();
    if (transcript) handleTranscript(transcript, set, get);
    else set({ phase: 'idle' });
  },

  cancel() {
    controller?.abort();
    set({ phase: 'idle', interim: '', transcript: '', commands: [], error: null });
  },

  submitText(text) {
    set({ transcript: text, interim: '' });
    handleTranscript(text, set, get);
  },

  async apply() {
    const { commands } = get();
    const ui = useUi.getState();
    const ops = commands.map((c) => c.op).filter(Boolean);

    // "Undo" is a command in its own right rather than an operation to send.
    if (commands.some((c) => c.intent === 'undo')) {
      await get().undoLast();
      set({ phase: 'done', commands: [], transcript: '' });
      return;
    }

    if (!ops.length) {
      set({ phase: 'error', error: ui.t('voice.notUnderstood') });
      return;
    }

    set({ phase: 'applying' });
    try {
      const result = await api.runBatch(ops as any, get().transcript);
      set({ phase: 'done', lastUndoId: result.undoId, commands: [], interim: '' });
      playCue('success');
      await useData.getState().refresh({ silent: true });

      ui.toast(ui.t('voice.applied', { n: result.applied }), 'success', {
        action: { label: ui.t('common.undo'), run: () => void get().undoLast() },
      });
      window.setTimeout(() => {
        if (get().phase === 'done') set({ phase: 'idle', transcript: '' });
      }, 1200);
    } catch (error) {
      set({ phase: 'error', error: (error as Error).message });
      playCue('error');
    }
  },

  async undoLast() {
    const undoId = get().lastUndoId;
    if (!undoId) return;
    const ui = useUi.getState();
    try {
      await api.undoBatch(undoId);
      set({ lastUndoId: null });
      await useData.getState().refresh({ silent: true });
      ui.toast(ui.t('voice.undone'), 'info');
    } catch (error) {
      ui.toast((error as Error).message, 'error');
    }
  },
}));

type SetState = (partial: Partial<VoiceState> | ((s: VoiceState) => Partial<VoiceState>)) => void;
type GetState = () => VoiceState;

function handleTranscript(transcript: string, set: SetState, get: GetState) {
  const ui = useUi.getState();
  set({ phase: 'parsing', error: null });

  const { commands } = parseUtterance(transcript, {
    items: useData.getState().items,
    locale: activeLocale(get()),
    defaultHour: Number(useAuth.getState().user?.settings.workStartHour ?? 9),
  });

  const usable = commands.filter((c) => c.op || c.intent === 'undo');
  if (!usable.length) {
    set({ phase: 'error', error: ui.t('voice.notUnderstood'), commands });
    playCue('error');
    return;
  }

  set({ commands, phase: 'confirming' });

  // Skip the confirmation step when the user has opted into it and every
  // command came back confidently parsed.
  const autoApply = Boolean(useAuth.getState().user?.settings.voiceAutoApply);
  const allConfident = usable.every((c) => c.confidence >= 0.7);
  if (autoApply && allConfident) void get().apply();
}
