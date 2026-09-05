/**
 * Capacitor, for the Android build.
 *
 * The app itself knows nothing about this. `webDir` is `dist-android/`, which `bun run build:android`
 * produces: the same sources as the website, bundled under the `capacitor` condition so `#transport`
 * resolves to the Android radio instead of the browser's. The two outputs are separate directories
 * because they are different bundles, and because `dist/` is what npm publishes.
 *
 * `androidScheme: "https"` keeps the page in a secure context, which the Web Crypto the cipher depends on
 * requires. The default is the same; it is written out because silence here would look like an oversight
 * rather than a decision.
 */

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.longsleep.heliobind",
  appName: "Heliobind",
  webDir: "dist-android",
  android: {
    // The page is served from the APK, so there is nothing to load over the network and nothing to allow.
    allowMixedContent: false,

    // Off, in every build, and not left to the default.
    //
    // Capacitor would otherwise follow the application's debuggable flag, which turns chrome://inspect on
    // for debug builds. An inspectable WebView is a console holding the page's own privileges: it reads
    // the constants a build carries and whatever the person holding the phone has stored, without
    // unpacking anything. Making that depend on which build somebody happens to have installed is a
    // distinction too easy to lose, so there is no build in which it is available.
    //
    // What remains for development: the app's own log pane, and `adb logcat -s Capacitor/Console`, which
    // still carries console output in a debug build.
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
