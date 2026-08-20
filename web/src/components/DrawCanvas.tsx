import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { paintStroke } from '../lib/brushes';
import { fontById } from '../lib/fonts';
import type { BrushId, CanvasText, Stroke, StrokePoint } from '../lib/types';

export type PaperStyle = 'plain' | 'lines' | 'grid' | 'dots';

export interface DrawCanvasHandle {
  clear(): void;
  undo(): void;
  redo(): void;
  getStrokes(): Stroke[];
  getTexts(): CanvasText[];
  load(strokes: Stroke[], texts?: CanvasText[]): void;
  addText(text: CanvasText): void;
  toDataUrl(maxWidth?: number): string;
  isEmpty(): boolean;
  size(): { width: number; height: number };
}

interface DrawCanvasProps {
  brush: BrushId;
  color: string;
  size: number;
  paper?: PaperStyle;
  /** When true a tap asks for text instead of drawing. */
  textMode?: boolean;
  onPlaceText?(at: { x: number; y: number }): void;
  onChange?(counts: { strokes: number; texts: number }): void;
  /** Fires once the pen has been still for a moment — used for live reading. */
  onSettle?(strokes: Stroke[]): void;
  settleDelayMs?: number;
}

/** One thing the user did, so undo can step back through ink and text alike. */
type Op = { kind: 'stroke'; stroke: Stroke } | { kind: 'text'; text: CanvasText };

/**
 * The drawing surface.
 *
 * Strokes are kept as vectors — every point carries pressure, tilt and a
 * timestamp — never as pixels. That is what lets a sketch be re-rendered at any
 * size, restyled for the light theme, fed to the handwriting reader without
 * any image processing, and stored in a few kilobytes.
 *
 * Finished work is kept on a second, offscreen canvas. Only the stroke
 * currently under the pen is repainted each frame, so a page full of charcoal
 * does not turn drawing into a slideshow.
 */
export const DrawCanvas = forwardRef<DrawCanvasHandle, DrawCanvasProps>(function DrawCanvas(
  { brush, color, size, paper = 'plain', textMode, onPlaceText, onChange, onSettle, settleDelayMs = 900 },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const committed = useRef<HTMLCanvasElement | null>(null);
  const ops = useRef<Op[]>([]);
  const redoStack = useRef<Op[]>([]);
  const active = useRef<Stroke | null>(null);
  const drawing = useRef(false);
  const startedAt = useRef(0);
  const settleTimer = useRef<number>();
  const dpr = useRef(1);

  const strokesOf = () => ops.current.filter((o): o is Extract<Op, { kind: 'stroke' }> => o.kind === 'stroke');
  const textsOf = () => ops.current.filter((o): o is Extract<Op, { kind: 'text' }> => o.kind === 'text');

  const announce = useCallback(() => {
    onChange?.({ strokes: strokesOf().length, texts: textsOf().length });
  }, [onChange]);

  const paintText = (ctx: CanvasRenderingContext2D, text: CanvasText) => {
    const family = fontById(text.font)?.stack ?? text.font;
    ctx.save();
    ctx.translate(text.x, text.y);
    if (text.rotation) ctx.rotate((text.rotation * Math.PI) / 180);
    ctx.font = `${text.italic ? 'italic ' : ''}${text.weight ?? 400} ${text.size}px ${family}`;
    ctx.fillStyle = text.color;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = text.align ?? 'start';
    // A newline in a note should behave like a newline.
    text.text.split('\n').forEach((row, index) => {
      ctx.fillText(row, 0, index * text.size * 1.25);
    });
    ctx.restore();
  };

  const paintOp = (ctx: CanvasRenderingContext2D, op: Op) => {
    if (op.kind === 'stroke') paintStroke(ctx, op.stroke, color, size);
    else paintText(ctx, op.text);
  };

  /** Repaint the offscreen layer from scratch. */
  const rebuildCommitted = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!committed.current) committed.current = document.createElement('canvas');
    const layer = committed.current;
    layer.width = canvas.width;
    layer.height = canvas.height;
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    for (const op of ops.current) paintOp(ctx, op);
  }, [color, size]);

  const paintPaper = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (paper === 'plain') return;
    const step = 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(140, 155, 255, 0.16)';
    ctx.fillStyle = 'rgba(140, 155, 255, 0.22)';
    ctx.lineWidth = 1;
    if (paper === 'lines') {
      for (let y = step; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    } else if (paper === 'grid') {
      for (let y = step; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      for (let x = step; x < width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    } else {
      for (let y = step; y < height; y += step) {
        for (let x = step; x < width; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  };

  /** Compose paper + committed layer + the stroke in progress. */
  const present = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintPaper(ctx, canvas.width / dpr.current, canvas.height / dpr.current);

    if (committed.current) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(committed.current, 0, 0);
      ctx.restore();
    }
    if (active.current) paintStroke(ctx, active.current, color, size);
  }, [color, size, paper]);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dpr.current = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.floor(rect.width * dpr.current));
    const height = Math.max(1, Math.floor(rect.height * dpr.current));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    rebuildCommitted();
    present();
  }, [rebuildCommitted, present]);

  useEffect(() => {
    resize();
    const observer = new ResizeObserver(resize);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [resize]);

  // Changing the paper style only affects the composite, not the ink.
  useEffect(() => {
    present();
  }, [present]);

  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>): StrokePoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      p: event.pressure > 0 ? event.pressure : 0.5,
      tx: event.tiltX,
      ty: event.tiltY,
      t: Math.round(performance.now() - startedAt.current),
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (textMode) {
      const rect = event.currentTarget.getBoundingClientRect();
      onPlaceText?.({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      return;
    }
    // Reject the palm: while a stylus is drawing, touch contacts are ignored.
    if (event.pointerType === 'touch' && active.current?.pointerType === 'pen') return;

    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    startedAt.current = performance.now();
    redoStack.current = [];
    active.current = {
      points: [pointFrom(event)],
      color,
      width: size,
      tool: brush,
      pointerType: event.pointerType === 'pen' ? 'pen' : event.pointerType === 'touch' ? 'touch' : 'mouse',
    };
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    present();
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !active.current) return;

    // Coalesced events give every sample the digitiser captured between
    // frames, which is what makes a fast stroke smooth instead of angular.
    const raw =
      typeof event.nativeEvent.getCoalescedEvents === 'function'
        ? event.nativeEvent.getCoalescedEvents()
        : [event.nativeEvent];
    const rect = event.currentTarget.getBoundingClientRect();

    for (const sample of raw) {
      active.current.points.push({
        x: sample.clientX - rect.left,
        y: sample.clientY - rect.top,
        p: sample.pressure > 0 ? sample.pressure : 0.5,
        tx: sample.tiltX,
        ty: sample.tiltY,
        t: Math.round(performance.now() - startedAt.current),
      });
    }
    present();
  }

  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;

    const stroke = active.current;
    active.current = null;
    if (stroke && stroke.points.length) {
      ops.current.push({ kind: 'stroke', stroke });
      // Only the finished stroke is added to the offscreen layer.
      const ctx = committed.current?.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
        paintStroke(ctx, stroke, color, size);
      }
      announce();
    }
    present();

    if (onSettle) {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(
        () => onSettle(strokesOf().map((o) => o.stroke)),
        settleDelayMs,
      );
    }
  }

  useImperativeHandle(ref, () => ({
    clear() {
      ops.current = [];
      redoStack.current = [];
      active.current = null;
      rebuildCommitted();
      present();
      announce();
    },
    undo() {
      const popped = ops.current.pop();
      if (popped) redoStack.current.push(popped);
      rebuildCommitted();
      present();
      announce();
    },
    redo() {
      const restored = redoStack.current.pop();
      if (restored) ops.current.push(restored);
      rebuildCommitted();
      present();
      announce();
    },
    getStrokes: () => strokesOf().map((o) => ({ ...o.stroke, points: [...o.stroke.points] })),
    getTexts: () => textsOf().map((o) => ({ ...o.text })),
    load(strokes, texts = []) {
      ops.current = [
        ...strokes.map((stroke) => ({ kind: 'stroke' as const, stroke })),
        ...texts.map((text) => ({ kind: 'text' as const, text })),
      ];
      redoStack.current = [];
      rebuildCommitted();
      present();
      announce();
    },
    addText(text) {
      ops.current.push({ kind: 'text', text });
      redoStack.current = [];
      const ctx = committed.current?.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
        paintText(ctx, text);
      }
      present();
      announce();
    },
    isEmpty: () => ops.current.length === 0,
    size: () => ({
      width: canvasRef.current?.width ?? 0,
      height: canvasRef.current?.height ?? 0,
    }),
    toDataUrl(maxWidth = 480) {
      const canvas = canvasRef.current;
      if (!canvas) return '';
      // Export the ink alone — the paper ruling is a guide, not part of the work.
      const source = committed.current ?? canvas;
      const scale = Math.min(1, maxWidth / Math.max(1, source.width));
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(source.width * scale));
      thumb.height = Math.max(1, Math.round(source.height * scale));
      const ctx = thumb.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL('image/png');
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className={`draw-canvas ${textMode ? 'is-text-mode' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
      onPointerLeave={endStroke}
      // Without this the browser scrolls the page instead of drawing.
      style={{ touchAction: 'none' }}
      aria-label="Drawing surface"
    />
  );
});
