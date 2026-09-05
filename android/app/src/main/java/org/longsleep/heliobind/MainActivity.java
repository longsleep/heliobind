package org.longsleep.heliobind;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Registered before the bridge starts, which is the only moment a plugin can be added: after
     * {@code super.onCreate} the web view is already loading and the page would ask for something that is
     * not there yet.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConstantsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
