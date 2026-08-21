package app.nexus.reminder;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Alarm sounds that already live on the phone.
 *
 * The app has always been able to play its own synthesized tones, and the web
 * build can upload an audio file. Neither is what someone means by "use my
 * ringtone" — they mean the sound they already chose, in the picker they
 * already know. Android exposes exactly that, so this hands it over rather
 * than building a worse copy of it.
 *
 * What comes back is a content:// URI. It is persisted with the reminder and
 * handed to the notification channel, so the OS plays it while the app is not
 * running. Read permission on that URI has to be taken persistently, or the
 * alarm would work today and fail silently after a reboot.
 */
@CapacitorPlugin(name = "DeviceSounds")
public class DeviceSoundsPlugin extends Plugin {

    /** Open the system ringtone picker. */
    @PluginMethod
    public void pickRingtone(PluginCall call) {
        String type = call.getString("type", "alarm");
        int ringtoneType;
        switch (type) {
            case "notification":
                ringtoneType = RingtoneManager.TYPE_NOTIFICATION;
                break;
            case "ringtone":
                ringtoneType = RingtoneManager.TYPE_RINGTONE;
                break;
            case "all":
                ringtoneType = RingtoneManager.TYPE_ALL;
                break;
            default:
                ringtoneType = RingtoneManager.TYPE_ALARM;
        }

        Intent intent = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, ringtoneType);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, call.getString("title", "Alarm sound"));
        // "Silent" is not an option worth offering in an alarm app.
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false);
        intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true);

        String existing = call.getString("current");
        if (existing != null && !existing.isEmpty()) {
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, Uri.parse(existing));
        }

        startActivityForResult(call, intent, "ringtonePicked");
    }

    @ActivityCallback
    private void ringtonePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        Uri uri = result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
        if (uri == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        JSObject value = new JSObject();
        value.put("cancelled", false);
        value.put("uri", uri.toString());
        value.put("name", titleFor(uri));
        call.resolve(value);
    }

    /**
     * Pick any audio file, including one the user's music app owns.
     *
     * Separate from the ringtone picker because the two answer different
     * questions: "which of my ringtones" and "which of my files".
     */
    @PluginMethod
    public void pickAudioFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "audioFilePicked");
    }

    @ActivityCallback
    private void audioFilePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        Uri uri = result.getData().getData();
        try {
            // Without this the URI stops working the next time the app starts,
            // and the alarm would fall back to a default tone with no warning.
            getContext()
                .getContentResolver()
                .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // Some providers do not offer persistable permission. The sound
            // still works for this install; it is not worth failing the pick.
        }

        JSObject value = new JSObject();
        value.put("cancelled", false);
        value.put("uri", uri.toString());
        value.put("name", displayName(uri));
        call.resolve(value);
    }

    /** Play a chosen sound once, so it can be heard before it is committed to. */
    @PluginMethod
    public void preview(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("No sound to play");
            return;
        }
        try {
            stopPreview();
            Ringtone ringtone = RingtoneManager.getRingtone(getContext(), Uri.parse(uriString));
            if (ringtone == null) {
                call.reject("That sound could not be opened");
                return;
            }
            current = ringtone;
            ringtone.play();
            call.resolve();
        } catch (Exception e) {
            call.reject("That sound could not be played", e);
        }
    }

    @PluginMethod
    public void stopPreview(PluginCall call) {
        stopPreview();
        call.resolve();
    }

    private Ringtone current;

    private void stopPreview() {
        if (current != null && current.isPlaying()) current.stop();
        current = null;
    }

    /** Is this sound still readable? A revoked or deleted file must be caught early. */
    @PluginMethod
    public void check(PluginCall call) {
        String uriString = call.getString("uri");
        JSObject value = new JSObject();
        if (uriString == null || uriString.isEmpty()) {
            value.put("ok", false);
            call.resolve(value);
            return;
        }
        boolean ok = false;
        try {
            Ringtone ringtone = RingtoneManager.getRingtone(getContext(), Uri.parse(uriString));
            ok = ringtone != null;
        } catch (Exception ignored) {
            ok = false;
        }
        value.put("ok", ok);
        call.resolve(value);
    }

    private String titleFor(Uri uri) {
        try {
            Ringtone ringtone = RingtoneManager.getRingtone(getContext(), uri);
            if (ringtone != null) {
                String title = ringtone.getTitle(getContext());
                if (title != null && !title.isEmpty()) return title;
            }
        } catch (Exception ignored) {
            // fall through to the file name
        }
        return displayName(uri);
    }

    private String displayName(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // fall through
        }
        String path = uri.getLastPathSegment();
        return path == null ? "Sound" : path;
    }
}
