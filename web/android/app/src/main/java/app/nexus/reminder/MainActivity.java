package app.nexus.reminder;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app rather than in a package have to be
        // registered before the bridge starts, or the web layer's calls to
        // them resolve to "not implemented".
        registerPlugin(DeviceSoundsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
