/**
 * What the package was given, read out of the native build.
 *
 * The three constants are compiled into `BuildConfig` rather than into the web assets, which are plain
 * files inside the APK — a key among them would be `unzip` and `grep` away, where DEX takes a decompiler.
 * A small plugin hands them across at start-up; see `ConstantsPlugin.java`.
 *
 * The call is made once, before the interface is wired, so everything downstream stays synchronous.
 */

import { registerPlugin } from "@capacitor/core";
import type { Secrets } from "../settings.ts";

interface Constants {
  supplied(): Promise<Secrets>;
}

const plugin = registerPlugin<Constants>("Constants");

/**
 * The constants this build carries, or nothing.
 *
 * A build given none of them answers with empty strings, and a package built before the plugin existed
 * answers with an error — both mean the same thing to the interface, which asks for them instead.
 */
export async function supplied(): Promise<Partial<Secrets>> {
  try {
    return await plugin.supplied();
  } catch {
    return {};
  }
}
