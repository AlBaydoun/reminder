import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import type { Stroke, StrokePoint } from '../lib/types';

export type Tool = 'pen' | 'marker' | 'pencil' | 'highlighter' | 'eraser';

export interface DrawCanvasHandle {
  clear(): void;
  undo(): void;
  redo(): void;
  getStrokes(): Stroke[];
  setStrokes(strokes: Stroke[]): void;
  toDataUrl(maxWidth?: number): string;
  isEmpty(): boolean;
}

interface DrawCanvasProps {
  tool: Tool;
  color: string;
  size: number;
  onChange?(strokeCount: number): void;
  /** Fires when the pen has been lifted and idle — used for live recognition. */
  onSettle?(strokes: Stroke[]): void;
  settleDelayMs?: number;
}

const TOOL_STYLE: Record<Tool, { alpha: number; widthScale: number; composite: GlobalCompositeOperation; jitter: number }> = {
  pen: { alpha: 1, widthScale: 1, composite: 'source-over', jitter: 0 },
  marker: { alpha: 0.92, widthScale: 2.4, composite: 'source-over', jitter: 0 },
  pencil: { alpha: 0.75, widthScale: 0.8, composite: 'source-over', jitter: 0.45 },
  highlighter: { alpha: 0.28, widthScale: 4.5, composite: 'multiply', jitter: 0 },
  eraser: { alpha: 1, widthScale: 3, composite: 'destination-out', jitter: 0 },
};

/**
 * Pressure- and tilt-aware drawing surface.
 *
 * Strokes are kept as vectors (every point carries pressure and tilt from the
 * PointerEvent), never as pixels: that is what lets the sketch be re-rendered
 * at any size, restyled for the light theme, saved compactly, and fed to the
 * recognizer without any image processing. The bitmap is only ever a view of
 * the vector data.
 */
export const DrawCanvas = forwardRef<DrawCanvasHandle, DrawCanvasProps>(function DrawCanvas(
  { tool, color, size, onChange, onSettle, settleDelayMs = 900 },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const redoStack = useRef<Stroke[]>([]);
  const active = useRef<Stroke | null>(null);
  const drawing = useRef(false);
  const settleTimer = useRef<number>();
  const dpr = useRef(1);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dpr.current = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr.current));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr.current));
    redraw();
  }, []);

  useEffect(() => {
    resize();
    const observer = new ResizeObserver(resize);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [resize]);

  function strokeWidth(point: StrokePoint, stroke: Stroke): number {
    const style = TOOL_STYLE[(stroke.tool ?? 'pen') as Tool];
    const base = (stroke.width ?? size) * style.widthScale;
    // A mouse reports a constant 0.5 pressure; only vary the width when the
    // device is actually giving us a real reading.
    const pressure = stroke.pointerType === 'pen' ? (point.p ?? 0.5) : 0.5;
    const tiltBoost = stroke.pointerType === 'pen' ? 1 + Math.min(0.6, Math.abs(point.tx ?? 0) / 90) : 1;
    return Math.max(0.6, base * (0.35 + pressure * 1.3) * tiltBoost);
  }

  function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
    const points = stroke.points;
    if (points.length < 2) {
      if (points.length === 1) {
        // A tap should still leave a dot.
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, strokeWidth(points[0], stroke) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    const style = TOOL_STYLE[(stroke.tool ?? 'pen') as Tool];
    // Each segment is drawn separately so the width can follow pressure along
    // the stroke — a single path can only have one lineWidth.
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1];
      const to = points[i];
      const jitter = style.jitter;
      ctx.beginPath();
      ctx.lineWidth = (strokeWidth(from, stroke) + strokeWidth(to, stroke)) / 2;
      ctx.moveTo(from.x + (Math.random() - 0.5) * jitter, from.y + (Math.random() - 0.5) * jitter);
      // Quadratic smoothing through the midpoint removes the polygon look.
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      ctx.quadraticCurveTo(from.x, from.y, midX, midY);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
  }

  function redraw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of [...strokes.current, ...(active.current ? [active.current] : [])]) {
      const style = TOOL_STYLE[(stroke.tool ?? 'pen') as Tool];
      ctx.save();
      ctx.globalAlpha = style.alpha;
      ctx.globalCompositeOperation = style.composite;
      ctx.strokeStyle = stroke.color ?? color;
      ctx.fillStyle = stroke.color ?? color;
      paintStroke(ctx, stroke);
      ctx.restore();
    }
  }

  function pointFrom(event: React.PointerEvent<HTMLCanvasElement>, startedAt: number): StrokePoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      p: event.pressure > 0 ? event.pressure : 0.5,
      tx: event.tiltX,
      ty: event.tiltY,
      t: Math.round(performance.now() - startedAt),
    };
  }

  const startedAt = useRef(0);

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    // Ignore the palm: when a stylus is in use, touch contacts are rejected.
    if (event.pointerType === 'touch' && active.current?.pointerType === 'pen') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    startedAt.current = performance.now();
    redoStack.current = [];
    active.current = {
      points: [pointFrom(event, startedAt.current)],
      color,
      width: size,
      tool,
      pointerType: event.pointerType === 'pen' ? 'pen' : event.pointerType === 'touch' ? 'touch' : 'mouse',
    };
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    redraw();
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !active.current) return;

    // Coalesced events give every sample the digitiser captured between
    // frames, which is what makes fast strokes smooth instead of angular.
    const events = typeof event.nativeEvent.getCoalescedEvents === 'function'
      ? event.nativeEvent.getCoalescedEvents()
      : [event.nativeEvent];

    const rect = event.currentTarget.getBoundingClientRect();
    for (const raw of events) {
      active.current.points.push({
        x: raw.clientX - rect.left,
        y: raw.clientY - rect.top,
        p: raw.pressure > 0 ? raw.pressure : 0.5,
        tx: raw.tiltX,
        ty: raw.tiltY,
        t: Math.round(performance.now() - startedAt.current),
      });
    }
    redraw();
  }

  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    if (active.current && active.current.points.length > 0) {
      strokes.current.push(active.current);
      onChange?.(strokes.current.length);
    }
    active.current = null;
    redraw();

    if (onSettle) {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => onSettle(strokes.current), settleDelayMs);
    }
  }

  useImperativeHandle(ref, () => ({
    clear() {
      strokes.current = [];
      redoStack.current = [];
      active.current = null;
      redraw();
      onChange?.(0);
    },
    undo() {
      const popped = strokes.current.pop();
      if (popped) redoStack.current.push(popped);
      redraw();
      onChange?.(strokes.current.length);
    },
    redo() {
      const restored = redoStack.current.pop();
      if (restored) strokes.current.push(restored);
      redraw();
      onChange?.(strokes.current.length);
    },
    getStrokes: () => strokes.current.map((s) => ({ ...s, points: [...s.points] })),
    setStrokes(next) {
      strokes.current = next.map((s) => ({ ...s, points: [...s.points] }));
      redoStack.current = [];
      redraw();
      onChange?.(strokes.current.length);
    },
    isEmpty: () => strokes.current.length === 0,
    toDataUrl(maxWidth = 480) {
      const canvas = canvasRef.current;
      if (!canvas) return '';
      const scale = Math.min(1, maxWidth / canvas.width);
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = thumb.getContext('2d');
      if (!ctx) return '';
      ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL('image/png');
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="draw-canvas"
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
