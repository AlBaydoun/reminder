package app.nexus.reminder;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import java.util.concurrent.TimeUnit;

/**
 * The next alarm, on the home screen.
 *
 * The point of this app is that you can stop watching the clock. A widget is
 * the purest form of that: the one thing that matters, visible without
 * unlocking anything, so there is no reason to open the app "just to check" —
 * which is the habit that breaks concentration in the first place.
 *
 * It draws only what the app has already told it. A widget cannot reach the
 * server, and one that showed a stale alarm as though it were current would be
 * worse than one that admits it does not know.
 */
public class NextAlarmWidget extends AppWidgetProvider {

    static final String PREFS = "nexus_widget";
    static final String KEY_TITLE = "title";
    static final String KEY_AT = "at";
    static final String KEY_UPDATED = "updated";
    static final String KEY_COUNT = "count";

    /** After this long with no word from the app, the countdown is not trustworthy. */
    private static final long STALE_AFTER_MS = TimeUnit.HOURS.toMillis(12);

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int id : widgetIds) render(context, manager, id);
    }

    static void renderAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(
            new android.content.ComponentName(context, NextAlarmWidget.class));
        for (int id : ids) render(context, manager, id);
    }

    private static void render(Context context, AppWidgetManager manager, int widgetId) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_next_alarm);

        String title = prefs.getString(KEY_TITLE, null);
        long at = prefs.getLong(KEY_AT, 0L);
        long updated = prefs.getLong(KEY_UPDATED, 0L);
        int count = prefs.getInt(KEY_COUNT, 0);

        boolean stale = updated > 0 && System.currentTimeMillis() - updated > STALE_AFTER_MS;

        if (title == null || at <= 0) {
            views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_empty_title));
            views.setTextViewText(R.id.widget_countdown, "");
            views.setTextViewText(R.id.widget_meta, context.getString(R.string.widget_empty_meta));
            views.setViewVisibility(R.id.widget_countdown, android.view.View.GONE);
        } else {
            views.setViewVisibility(R.id.widget_countdown, android.view.View.VISIBLE);
            views.setTextViewText(R.id.widget_title, title);

            // A Chronometer counts on its own, once a second, with the widget
            // asleep. Redrawing from the app every second instead would be a
            // wakeup per second for a number nobody is watching most of the time.
            views.setChronometerCountDown(R.id.widget_countdown, true);
            views.setChronometer(
                R.id.widget_countdown,
                android.os.SystemClock.elapsedRealtime() + (at - System.currentTimeMillis()),
                null,
                true);

            String meta;
            if (stale) {
                meta = context.getString(R.string.widget_stale);
            } else if (count > 1) {
                meta = context.getResources().getQuantityString(
                    R.plurals.widget_more_alarms, count - 1, count - 1);
            } else {
                meta = context.getString(R.string.widget_only_alarm);
            }
            views.setTextViewText(R.id.widget_meta, meta);
        }

        // Tapping it opens the app, which is the only useful thing it can do.
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pending);

        manager.updateAppWidget(widgetId, views);
    }
}
