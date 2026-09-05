package org.longsleep.heliobind;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hands the page the three protocol constants, when this build was given them.
 *
 * <p>They live in {@code BuildConfig} rather than in the web assets, because the assets are plain files
 * inside the package and a key among them is <code>unzip</code> and <code>grep</code> away. Compiled into
 * DEX they take a decompiler instead, which is the bar the vendor's own application sets — and the reason
 * a package may carry them where the website may not.
 *
 * <p>The page does not depend on any of this. A build given nothing answers with empty strings, and the
 * interface asks for them exactly as it does in a browser.
 */
@CapacitorPlugin(name = "Constants")
public class ConstantsPlugin extends Plugin {

    /** Everything the build was given. Empty strings where it was given nothing. */
    @PluginMethod
    public void supplied(PluginCall call) {
        JSObject supplied = new JSObject();
        supplied.put("cipherKey", BuildConfig.CIPHER_KEY);
        supplied.put("cipherIv", BuildConfig.CIPHER_IV);
        supplied.put("bindKey", BuildConfig.BIND_KEY);
        call.resolve(supplied);
    }
}
