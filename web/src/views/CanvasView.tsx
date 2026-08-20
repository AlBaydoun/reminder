import { motion } from 'framer-motion';
import {
  Brush,
  Eraser,
  Highlighter,
  ListPlus,
  Pen,
  Pencil,
  Redo2,
  Save,
  ScanText,
  Trash,
  Undo2,
  Wand2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DrawCanvas, type DrawCanvasHandle, type Tool } from '../components/DrawCanvas';
import { Spinner } from '../components/ui';
import { api } from '../lib/api';
import { hasNativeHandwriting, recognizeStrokes } from '../lib/recognition/handwriting';
import { GESTURE_I18N, type GestureAction } from '../lib/recognition/templates';
import { iconForTitle } from '../lib/text';
import { useData } from '../store/data';
import { useTranslation, useUi } from '../store/ui';

const TOOLS: Array<{ tool: Tool; icon: typeof Pen; key: keyof typeof LABEL_KEYS }> = [
  { tool: 'pen', icon: Pen, key: 'pen' },
  { tool: 'marker', icon: Brush, key: 'marker' },
  { tool: 'pencil', icon: Pencil, key: 'pencil' },
  { tool: 'highlighter', icon: Highlighter, key: 'highlighter' },
  { tool: 'eraser', icon: Eraser, key: 'eraser' },
];

const LABEL_KEYS = { pen: 1, marker: 1, pencil: 1, highlighter: 1, eraser: 1 } as const;

const PALETTE = ['#7ce7ff', '#a68bff', '#ff7ce0', '#3ddc97', '#ffc46b', '#ff6b8a', '#eef1ff', '#131731'];

/**
 * Draw or handwrite. Two things happen with what you draw: the sketch can be
 * saved and attached to any item, and the strokes are read — as text where the
 * browser has a handwriting engine, and as shapes and pen gestures everywhere.
 */
export function CanvasView() {
  const { dict, locale } = useTranslation();
  const toast = useUi((s) => s.toast);
  const items = useData((s) => s.items);
  const drawings = useData((s) => s.drawings);
  const refreshDrawings = useData((s) => s.refreshDrawings);
  const createItem = useData((s) => s.createItem);
  const updateItem = useData((s) => s.updateItem);
  const deleteItem = useData((s) => s.deleteItem);
  const toggleComplete = useData((s) => s.toggleComplete);

  const canvas = useRef<DrawCanvasHandle>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(PALETTE[0]);
  const [size, setSize] = useState(3);
  const [strokeCount, setStrokeCount] = useState(0);
  const [reading, setReading] = useState(false);
  const [recognized, setRecognized] = useState<string | null>(null);
  const [gesture, setGesture] = useState<GestureAction | null>(null);
  const [attachTo, setAttachTo] = useState<string>('');

  useEffect(() => {
    void refreshDrawings();
  }, [refreshDrawings]);

  async function read() {
    const strokes = canvas.current?.getStrokes() ?? [];
    if (!strokes.length) return;
    setReading(true);
    setGesture(null);
    try {
      const result = await recognizeStrokes(strokes, locale);
      if (!result) {
        setRecognized(null);
        toast(dict.canvas.notRecognized, 'warn');
        return;
      }
      setRecognized(result.text);
      if (result.gesture) {
        setGesture(result.gesture);
        toast(
          dict.canvas.gestureDetected.replace(
            '{name}',
            (dict.canvas.gestures as Record<string, string>)[gestureKey(result.gesture)] ?? result.text,
          ),
          'info',
        );
      } else {
        toast(dict.canvas.recognized.replace('{text}', result.text), 'success');
      }
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
    setGesture(null);
    canvas.current?.clear();
  }

  async function saveSketch() {
    const strokes = canvas.current?.getStrokes() ?? [];
    if (!strokes.length) return;
    const element = document.querySelector('.draw-canvas') as HTMLCanvasElement | null;
    try {
      await api.createDrawing({
        itemId: attachTo || null,
        title: recognized ?? '',
        strokes,
        width: element?.width ?? 1000,
        height: element?.height ?? 700,
        thumbnail: canvas.current?.toDataUrl(420) ?? '',
        recognizedText: recognized ?? '',
      });
      await refreshDrawings();
      toast(dict.canvas.saved, 'success');
      canvas.current?.clear();
      setRecognized(null);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function saveAsTask() {
    const title = recognized?.trim();
    if (!title) return;
    const created = await createItem({ title, icon: iconForTitle(title), parentId: attachTo || null });
    if (created) {
      toast(`${created.icon || '✓'} ${created.title}`, 'success');
      canvas.current?.clear();
      setRecognized(null);
    }
  }

  return (
    <div className="view view--canvas">
      <header className="view__head">
        <div className="grow">
          <h1 className="view__title">{dict.canvas.title}</h1>
          <p className="view__sub muted">{dict.canvas.subtitle}</p>
        </div>
      </header>

      <div className="canvas-toolbar glass">
        <div className="canvas-toolbar__group">
          {TOOLS.map(({ tool: value, icon: Icon }) => (
            <button
              key={value}
              className={`btn btn-icon btn-sm ${tool === value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTool(value)}
              aria-label={dict.canvas[value]}
              title={dict.canvas[value]}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>

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
          <span className="faint">{dict.canvas.pressure}</span>
          <input
            type="range"
            min={1}
            max={14}
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
            aria-label={dict.canvas.pressure}
          />
        </label>

        <div className="canvas-toolbar__group grow" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => canvas.current?.undo()} aria-label={dict.canvas.undo}>
            <Undo2 size={16} />
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => canvas.current?.redo()} aria-label={dict.canvas.redo}>
            <Redo2 size={16} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => {
              canvas.current?.clear();
              setRecognized(null);
              setGesture(null);
            }}
            aria-label={dict.canvas.clear}
          >
            <Trash size={16} />
          </button>
        </div>
      </div>

      <div className="canvas-stage glass">
        <DrawCanvas
          ref={canvas}
          tool={tool}
          color={color}
          size={size}
          onChange={setStrokeCount}
        />
        {strokeCount === 0 && <p className="canvas-stage__hint faint">{dict.canvas.subtitle}</p>}
      </div>

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

        <button className="btn" onClick={() => void read()} disabled={strokeCount === 0 || reading}>
          {reading ? <Spinner size={15} /> : <ScanText size={16} />}
          {reading ? dict.canvas.recognizing : dict.canvas.recognize}
        </button>

        {recognized && !gesture && (
          <button className="btn btn-primary" onClick={() => void saveAsTask()}>
            <ListPlus size={16} />
            {dict.canvas.saveAsItem}
          </button>
        )}

        {gesture && attachTo && (
          <motion.button
            className="btn btn-primary"
            onClick={() => void applyGesture()}
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
          >
            <Wand2 size={16} />
            {(dict.canvas.gestures as Record<string, string>)[gestureKey(gesture)]}
          </motion.button>
        )}

        <button className="btn" onClick={() => void saveSketch()} disabled={strokeCount === 0}>
          <Save size={16} />
          {dict.canvas.saveDrawing}
        </button>
      </div>

      {recognized && (
        <motion.p className="canvas-result glass" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {dict.canvas.recognized.replace('{text}', recognized)}
        </motion.p>
      )}

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
    </div>
  );
}

/** Map a gesture action back to its i18n key suffix. */
function gestureKey(action: GestureAction): string {
  return GESTURE_I18N[action].split('.').pop() ?? 'check';
}
