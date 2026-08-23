import type { DueReminder } from '../types';
import { isAndroid, isNative } from './bridge';

/**
 * The home screen's copy of what is coming next.
 *
 * A widget cannot reach the server, so the app pushes to it. This is the whole
 * of that contract: a title, a moment, and how many alarms are behind it —
 * deliberately not the app's own model, so the widget can draw itself without
 * knowing what a task is.
 *
 * Android only. iOS widgets are a separate binary written in SwiftUI with an
 * App Group between them, which is real work rather than a wrapper, and it is
 * honest to say so instead of shipping something that silently does nothing.
 */

interface WidgetPlugin {
  setNextAlarm(options: { title?: string; at?: number; count: number }): Promise<{ ok: boolean }>;
  isPlaced(): Promise<{ placed: boolean; count: number }>;
}

let cached: WidgetPlugin | null | undefined;

async function plugin(): Promise<WidgetPlugin | null> {
  if (cached !== undefined) return cached;
  if (!isNative() || !isAndroid()) {
    cached = null;
    return null;
  }
  try {
    const { registerPlugin } = await import('@capacitor/core');
    cached = registerPlugin<WidgetPlugin>('Widget');
  } catch {
    cached = null;
  }
  return cached;
}

export const widgetSupported = () => isNative() && isAndroid();

/** What was last pushed, so an unchanged schedule is not pushed again. */
let lastPushed = '';

/**
 * Tell the home screen about the soonest alarm.
 *
 * Called after every sync. Alarms on finished tasks are skipped for the same
 * reason they no longer ring: a widget counting down to something already done
 * is worse than an empty one.
 */
export async function updateWidget(reminders: DueReminder[]): Promise<void> {
  const api = await plugin();
  if (!api) return;

  const upcoming = reminders
    .filter((r) => r.item.status !== 'done' && r.nextFireAt && new Date(r.nextFireAt).getTime() > Date.now())
    .sort((a, b) => (a.nextFireAt ?? '').localeCompare(b.nextFireAt ?? ''));

  const next = upcoming[0];
  const payload = next
    ? {
        title: `${next.item.icon || '⏰'} ${next.label || next.item.title}`.trim(),
        at: new Date(next.nextFireAt as string).getTime(),
        count: upcoming.length,
      }
    : { count: 0 };

  const signature = JSON.stringify(payload);
  if (signature === lastPushed) return;
  lastPushed = signature;

  await api.setNextAlarm(payload).catch(() => undefined);
}

export async function widgetIsPlaced(): Promise<boolean> {
  const api = await plugin();
  if (!api) return false;
  return api
    .isPlaced()
    .then((r) => r.placed)
    .catch(() => false);
}
