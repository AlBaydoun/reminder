import { isNative, loadApp, loadLocalNotifications } from './bridge';

/**
 * What happens when someone acts on an alarm from outside the app.
 *
 * The web build routes this through the service worker. A phone has no service
 * worker involved: the OS delivers the tap to the app directly, either while
 * it is running or by launching it. Both cases arrive here, and both have to
 * end with the same thing happening to the task.
 */

export interface NativeAlarmHandlers {
  onAction(action: string, reminderId: string, itemId?: string): void;
  /** The alarm fired while the app happened to be open. */
  onReceived(reminderId: string, itemId?: string): void;
  /** The app came back to the foreground; the schedule may be stale. */
  onResume(): void;
}

let attached = false;
const cleanups: Array<() => void> = [];

export async function attachNativeListeners(handlers: NativeAlarmHandlers): Promise<void> {
  if (!isNative() || attached) return;
  attached = true;

  const LocalNotifications = await loadLocalNotifications();
  if (LocalNotifications) {
    const performed = await LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (event) => {
        const extra = (event.notification.extra ?? {}) as { reminderId?: string; itemId?: string };
        if (!extra.reminderId) return;
        // 'tap' is the id the plugin uses when the body was pressed rather
        // than a button; that means "open it", not "dismiss it".
        const action = event.actionId === 'tap' ? 'open' : event.actionId;
        handlers.onAction(action, extra.reminderId, extra.itemId);
      },
    );
    cleanups.push(() => void performed.remove());

    const received = await LocalNotifications.addListener('localNotificationReceived', (n) => {
      const extra = (n.extra ?? {}) as { reminderId?: string; itemId?: string; kind?: string };
      // A pre-alert is not the alarm; it should not raise the ringing screen.
      if (!extra.reminderId || extra.kind === 'lead') return;
      handlers.onReceived(extra.reminderId, extra.itemId);
    });
    cleanups.push(() => void received.remove());
  }

  const App = await loadApp();
  if (App) {
    const stateChange = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) handlers.onResume();
    });
    cleanups.push(() => void stateChange.remove());
  }
}

export function detachNativeListeners() {
  for (const cleanup of cleanups.splice(0)) cleanup();
  attached = false;
}
