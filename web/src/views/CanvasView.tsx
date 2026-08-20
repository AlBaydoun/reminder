import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  Eraser,
  ListPlus,
  PenLine,
  Redo2,
  Save,
  ScanText,
  Trash,
  Type,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DrawCanvas, type DrawCanvasHandle, type PaperStyle } from '../components/DrawCanvas';
import { FontPicker } from '../components/FontPicker';
import { Modal, Spinner, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { BRUSHES, brushById } from '../lib/brushes';
import { DEFAULT_CANVAS_FONT, ensureFont, fontById } from '../lib/fonts';
import { renderInk } from '../lib/inkWriter';
import { hasNativeHandwriting, recognizeStrokes } from '../lib/recognition/handwriting';
import { readHandwriting } from '../lib/recognition/words';
import { GESTURE_I18N, type GestureAction } from '../lib/recognition/templates';
import { iconForTitle } from '../lib/text';
import type { BrushId, CanvasText, Stroke } from '../lib/types';
import { useAuth } from '../store/auth';
import { useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

const PALETTE = ['#7ce7ff', '#a68bff', '#ff7ce0', '#3ddc97', '#ffc46b', '#ff6b8a', '#eef1ff', '#0b1020'];
const PAPERS: PaperStyle[] = ['plain', 'lines', 'grid', 'dots'];
const FAMILY_ORDER = ['ink', 'paint', 'dry', 'effect', 'tool'] as const;

/**
 * Write or draw. Whatever is written is read back into words, and those words
 * are what make the entry searchable — but the entry keeps the handwriting as
 * its face. A handwritten task is a task: it has a checkbox, a date, alarms
 * and a place in the tree, exactly like a typed one.
 */
export function CanvasView() {
  const { dict, locale } = useTranslation();
  const toast = useUi((s) => s.toast);
  const items = useData((s) => s.items);
  const drawings = useData((s) => s.drawings);
  const refreshDrawings = useData((s) => s.refreshDrawings);
  const refresh = useData((s) => s.refresh);
  const createItem = useData((s) => s.createItem);
  const updateItem = useData((s) => s.updateItem);
  const deleteItem = useData((s) => s.deleteItem);
  const toggleComplete = useData((s) => s.toggleComplete);
  const settings = useAuth((s) => s.user?.settings);

  const canvas = useRef<DrawCanvasHandle>(null);
  const [brush, setBrush] = useState<BrushId>('fineliner');
  const [color, setColor] = useState(PALETTE[0]);
  const [size, setSize] = useState(3);
  const [paper, setPaper] = useState<PaperStyle>('lines');
  const [counts, setCounts] = useState({ strokes: 0, texts: 0 });

  const [transcript, setTranscript] = useState('');
  const [confidence, setConfidence] = useState(0);
  const [edited, setEdited] = useState(false);
  const [reading, setReading] = useState(false);
  const [gesture, setGesture] = useState<GestureAction | null>(null);
  const [keepInk, setKeepInk] = useState(true);
  const [attachTo, setAttachTo] = useState('');

  const [textMode, setTextMode] = useState(false);
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);
  const [draftText, setDraftText] = useState('');
  const [font, setFont] = useState<string>((settings?.canvasFont as string) ?? DEFAULT_CANVAS_FONT);
  const [fontSize, setFontSize] = useState(34);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);

  useEffect(() => {
    void refreshDrawings();
  }, [refreshDrawings]);

  useEffect(() => {
    void ensureFont(font);
  }, [font]);

  const brushGroups = useMemo(
    () => FAMILY_ORDER.map((family) => ({ family, brushes: BRUSHES.filter((b) => b.family === family) })),
    [],
  );

  /** Read as the pen rests, so the words appear while you write. */
  const onSettle = (strokes: Stroke[]) => {
    if (edited || textMode) return;
    const read = readHandwriting(strokes);
    if (read.text) {
      setTranscript(read.text);
      setConfidence(read.confidence);
    }
  };

  async function readNow() {
    const strokes = canvas.current?.getStrokes() ?? [];
    if (!strokes.length) return;
    setReading(true);
    setGesture(null);
    try {
      const result = await recognizeStrokes(strokes, locale);
      if (!result) {
        toast(dict.canvas.notRecognized, 'warn');
        return;
      }
      if (result.gesture) {
        setGesture(result.gesture);
        toast(
          dict.canvas.gestureDetected.replace(
            '{name}',
            (dict.canvas.gestures as Record<string, string>)[gestureKey(result.gesture)] ?? result.text,
          ),
          'info',
        );
        return;
      }
      setTranscript(result.text);
      setConfidence(result.confidence);
      setEdited(false);
    } finally {
      setReading(false);
    }
  }

  async function applyGesture() {
    if (!gesture || !attachTo) return;
    const target = items.find((i) => i.id === attachTo);
    if (!target) return;

    switch (gesture) {
      case 'complete':
        await toggleComplete(target.id, true);
        break;
      case 'pin':
        await updateItem(target.id, { pinned: !target.pinned });
        break;
      case 'delete':
        await deleteItem(target.id);
        break;
      case 'raise_priority':
        await updateItem(target.id, { priority: Math.min(4, target.priority + 1) });
        break;
      case 'make_category':
        await createItem({ title: dict.item.newItem, parentId: target.id });
        break;
      case 'unclear':
        await updateItem(target.id, { tags: [...new Set([...target.tags, '?'])] });
        break;
      default:
        break;
    }
    toast(dict.settings.saved, 'success');
    reset();
  }

  function reset() {
    canvas.current?.clear();
    setTranscript('');
    setConfidence(0);
    setEdited(false);
    setGesture(null);
  }

  async function saveDrawing(itemId: string | null) {
    const strokes = canvas.current?.getStrokes() ?? [];
    const texts = canvas.current?.getTexts() ?? [];
    const dimensions = canvas.current?.size() ?? { width: 1000, height: 600 };
    return api.createDrawing({
      itemId,
      title: transcript,
      strokes,
      texts,
      width: dimensions.width,
      height: dimensions.height,
      // Cropped to the writing itself, so a short note on a big sheet still
      // fills its row instead of rendering as a speck in a sea of blank paper.
      thumbnail: renderInk(strokes, texts, { maxWidth: 560 }),
      recognizedText: transcript,
    });
  }

  /**
   * Turn what is on the canvas into a real task. The transcription becomes the
   * title — which is what search, voice and the reasoning engine all read —
   * while the ink stays as the row's face.
   */
  async function createTask() {
    const title = transcript.trim();
    if (!title) {
      toast(dict.canvas.notRecognized, 'warn');
      return;
    }
    try {
      const drawing = await saveDrawing(null);
      const created = await createItem({
        title,
        icon: keepInk ? '' : iconForTitle(title),
        parentId: attachTo || null,
        displayMode: keepInk ? 'ink' : 'text',
        inkDrawingId: drawing.id,
      });
      if (!created) return;
      // Link the sketch back, so deleting the task takes its ink with it.
      await api.updateDrawing(drawing.id, { itemId: created.id });
      await refresh({ silent: true });
      await refreshDrawings();
      toast(`${created.icon || '✍️'} ${created.title}`, 'success');
      reset();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function saveSketch() {
    if (!counts.strokes && !counts.texts) return;
    try {
      await saveDrawing(attachTo || null);
      await refreshDrawings();
      toast(dict.canvas.saved, 'success');
      reset();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  function placeText() {
    if (!pendingText || !draftText.trim()) {
      setPendingText(null);
      setDraftText('');
      return;
    }
    const text: CanvasText = {
      x: pendingText.x,
      y: pendingText.y,
      text: draftText,
      font,
      size: fontSize,
      color,
      weight: 400,
    };
    canvas.current?.addText(text);
    setPendingText(null);
    setDraftText('');
  }

  const isEmpty = counts.strokes === 0 && counts.texts === 0;
  const lowConfidence = transcript.length > 0 && confidence > 0 && confidence < 0.62;

  return (
    <div className="view view--canvas">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.canvas.title}</h1>
          <p className="view__sub muted">{dict.canvas.subtitle}</p>
        </div>
      </header>

      <div className="canvas-toolbar glass">
        <div className="brush-bar">
          {brushGroups.map(({ family, brushes }) => (
            <div key={family} className="brush-bar__group" title={dict.canvas.families[family]}>
              {brushes.map((entry) => (
                <button
                  key={entry.id}
                  className={`brush-chip ${brush === entry.id && !textMode ? 'is-active' : ''}`}
                  onClick={() => {
                    setBrush(entry.id);
                    setTextMode(false);
                  }}
                  title={dict.canvas.brushes[entry.label]}
                  aria-label={dict.canvas.brushes[entry.label]}
                >
                  <BrushGlyph id={entry.id} color={entry.id === 'eraser' ? 'var(--text-dim)' : color} />
                  <span className="brush-chip__name">{dict.canvas.brushes[entry.label]}</span>
                </button>
              ))}
            </div>
          ))}
          <button
            className={`brush-chip ${textMode ? 'is-active' : ''}`}
            onClick={() => setTextMode(!textMode)}
            title={dict.canvas.text.tool}
          >
            <Type size={16} />
            <span className="brush-chip__name">{dict.canvas.text.tool}</span>
          </button>
        </div>

        <div className="canvas-toolbar__row">
          <div className="canvas-toolbar__group">
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                className={`swatch ${color === swatch ? 'is-active' : ''}`}
                style={{ background: swatch }}
                onClick={() => setColor(swatch)}
                aria-label={swatch}
              />
            ))}
          </div>

          <label className="canvas-toolbar__size">
            <span className="faint">{textMode ? dict.canvas.text.size : dict.canvas.pressure}</span>
            <input
              type="range"
              min={textMode ? 12 : 1}
              max={textMode ? 96 : 18}
              value={textMode ? fontSize : size}
              onChange={(event) =>
                textMode ? setFontSize(Number(event.target.value)) : setSize(Number(event.target.value))
              }
            />
          </label>

          {textMode && (
            <button className="btn btn-sm" onClick={() => setFontPickerOpen(true)} style={{ fontFamily: fontById(font)?.stack }}>
              {fontById(font)?.name ?? dict.canvas.text.font}
            </button>
          )}

          <div className="canvas-toolbar__group">
            <span className="faint">{dict.canvas.paper.label}</span>
            {PAPERS.map((style) => (
              <button
                key={style}
                className={`chip chip--action chip--tiny ${paper === style ? 'is-active' : ''}`}
                onClick={() => setPaper(style)}
              >
                {dict.canvas.paper[style]}
              </button>
            ))}
          </div>

          <div className="canvas-toolbar__group grow" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => canvas.current?.undo()} aria-label={dict.canvas.undo}>
              <Undo2 size={16} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => canvas.current?.redo()} aria-label={dict.canvas.redo}>
              <Redo2 size={16} />
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={reset} aria-label={dict.canvas.clear}>
              <Trash size={16} />
            </button>
          </div>
        </div>
      </div>

      <div className="canvas-stage glass">
        <DrawCanvas
          ref={canvas}
          brush={brush}
          color={color}
          size={size}
          paper={paper}
          textMode={textMode}
          onPlaceText={setPendingText}
          onChange={setCounts}
          onSettle={onSettle}
        />
        {isEmpty && (
          <p className="canvas-stage__hint faint">
            {textMode ? dict.canvas.text.hint : dict.canvas.subtitle}
          </p>
        )}
      </div>

      <AnimatePresence>
        {(transcript || gesture) && (
          <motion.div
            className="transcript glass"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
          >
            {gesture ? (
              <>
                <Wand2 size={17} className="transcript__icon" />
                <span className="grow">
                  {(dict.canvas.gestures as Record<string, string>)[gestureKey(gesture)]}
                </span>
                <button className="btn btn-sm btn-primary" onClick={() => void applyGesture()} disabled={!attachTo}>
                  <Check size={14} />
                  {dict.common.confirm}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setGesture(null)} aria-label={dict.common.cancel}>
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                <PenLine size={17} className="transcript__icon" />
                <div className="grow">
                  <label className="transcript__label faint" htmlFor="transcript-input">
                    {dict.canvas.transcript}
                    {confidence > 0 && <span className="mono"> · {Math.round(confidence * 100)}%</span>}
                  </label>
                  <input
                    id="transcript-input"
                    className="input transcript__input"
                    value={transcript}
                    onChange={(event) => {
                      setTranscript(event.target.value);
                      setEdited(true);
                    }}
                  />
                  <p className="faint transcript__hint">
                    {lowConfidence ? dict.canvas.lowConfidence : dict.canvas.transcriptHint}
                  </p>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="canvas-actions">
        <select
          className="select"
          value={attachTo}
          onChange={(event) => setAttachTo(event.target.value)}
          aria-label={dict.canvas.attachTo}
        >
          <option value="">{dict.canvas.attachTo}…</option>
          {items
            .filter((i) => !i.deletedAt)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.icon} {item.title}
              </option>
            ))}
        </select>

        <button className="btn" onClick={() => void readNow()} disabled={isEmpty || reading}>
          {reading ? <Spinner size={15} /> : <ScanText size={16} />}
          {reading ? dict.canvas.recognizing : transcript ? dict.canvas.readAgain : dict.canvas.recognize}
        </button>

        <button className="btn btn-primary" onClick={() => void createTask()} disabled={!transcript.trim()}>
          <ListPlus size={16} />
          {dict.canvas.createTask}
        </button>

        <button className="btn" onClick={() => void saveSketch()} disabled={isEmpty}>
          <Save size={16} />
          {dict.canvas.saveDrawing}
        </button>

        <Toggle checked={keepInk} onChange={setKeepInk} label={dict.canvas.keepInk} hint={dict.canvas.keepInkHint} />
      </div>

      <section className="panel glass">
        <header className="panel__head">
          <h2>{dict.canvas.gesturesTitle}</h2>
        </header>
        <ul className="gesture-legend">
          {Object.entries(dict.canvas.gestures).map(([key, label]) => (
            <li key={key}>{label}</li>
          ))}
        </ul>
        {!hasNativeHandwriting() && <p className="faint">{dict.canvas.handwritingUnavailable}</p>}
      </section>

      {drawings.length > 0 && (
        <section className="panel glass">
          <header className="panel__head">
            <h2>{dict.canvas.title}</h2>
          </header>
          <div className="sketch-grid">
            {drawings.map((drawing) => (
              <figure key={drawing.id} className="sketch-card">
                {drawing.thumbnail ? (
                  <img src={drawing.thumbnail} alt={drawing.recognizedText || dict.canvas.title} />
                ) : (
                  <div className="sketch-card__placeholder" />
                )}
                <figcaption className="truncate faint">
                  {drawing.recognizedText || new Date(drawing.createdAt).toLocaleDateString()}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <Modal
        open={Boolean(pendingText)}
        onClose={() => {
          setPendingText(null);
          setDraftText('');
        }}
        title={dict.canvas.text.tool}
        footer={
          <>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setPendingText(null);
                setDraftText('');
              }}
            >
              {dict.common.cancel}
            </button>
            <button className="btn btn-primary" onClick={placeText} disabled={!draftText.trim()}>
              {dict.canvas.text.add}
            </button>
          </>
        }
      >
        <textarea
          className="textarea"
          autoFocus
          value={draftText}
          placeholder={dict.canvas.text.placeholder}
          style={{ fontFamily: fontById(font)?.stack, fontSize: Math.min(32, fontSize) }}
          onChange={(event) => setDraftText(event.target.value)}
        />
        <FontPicker value={font} onChange={setFont} filterByLocale={false} />
      </Modal>

      <Modal open={fontPickerOpen} onClose={() => setFontPickerOpen(false)} title={dict.canvas.text.font}>
        <FontPicker value={font} onChange={setFont} filterByLocale={false} />
      </Modal>
    </div>
  );
}

/** A tiny preview of what each brush lays down. */
function BrushGlyph({ id, color }: { id: BrushId; color: string }) {
  const brush = brushById(id);
  if (id === 'eraser') return <Eraser size={16} />;

  const width = Math.min(6, 1 + brush.widthScale * 1.1);
  return (
    <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden>
      <path
        d="M2 12 C 8 12, 8 4, 13 4 S 20 12, 24 5"
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        opacity={brush.opacity}
        strokeDasharray={brush.dash ? `${brush.dash[0] * 2} ${brush.dash[1] * 2}` : undefined}
        style={brush.glow ? { filter: `drop-shadow(0 0 3px ${color})` } : undefined}
      />
    </svg>
  );
}

/** Map a gesture action back to its i18n key suffix. */
function gestureKey(action: GestureAction): string {
  return GESTURE_I18N[action].split('.').pop() ?? 'check';
}
