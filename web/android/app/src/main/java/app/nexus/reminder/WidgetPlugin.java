package app.nexus.reminder;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * How the app tells the home screen what is coming.
 *
 * The widget has no way of its own to reach the server, so the app pushes the
 * next alarm to it whenever the schedule changes. Everything is stored as
 * plain values rather than the app's own model: a widget should be able to
 * draw itself from what it has, without knowing anything about tasks.
 */
@CapacitorPlugin(name = "Widget")
public class WidgetPlugin extends Plugin {

    @PluginMethod
    public void setNextAlarm(PluginCall call) {
        Context context = getContext();
        SharedPreferences.Editor editor =
            context.getSharedPreferences(NextAlarmWidget.PREFS, Context.MODE_PRIVATE).edit();

        String title = call.getString("title");
        Double at = call.getDouble("at");

        if (title == null || at == null || at <= 0) {
            editor.remove(NextAlarmWidget.KEY_TITLE).remove(NextAlarmWidget.KEY_AT);
        } else {
            editor.putString(NextAlarmWidget.KEY_TITLE, title);
            editor.putLong(NextAlarmWidget.KEY_AT, at.longValue());
        }
        editor.putInt(NextAlarmWidget.KEY_COUNT, call.getInt("count", 0));
        editor.putLong(NextAlarmWidget.KEY_UPDATED, System.currentTimeMillis());
        editor.apply();

        NextAlarmWidget.renderAll(context);

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /** Is a widget actually on a home screen? Saves pushing updates nobody sees. */
    @PluginMethod
    public void isPlaced(PluginCall call) {
        android.appwidget.AppWidgetManager manager =
            android.appwidget.AppWidgetManager.getInstance(getContext());
        int[] ids = manager.getAppWidgetIds(
            new android.content.ComponentName(getContext(), NextAlarmWidget.class));
        JSObject result = new JSObject();
        result.put("placed", ids.length > 0);
        result.put("count", ids.length);
        call.resolve(result);
    }
}
