/**
 * The package has no worker and nothing to install, so neither offer exists here.
 *
 * Both of the things `web.ts` does are answers to being a website. Neither question is asked of the
 * package:
 *
 * - **Offline is not a state the package can be out of.** Its assets are files inside the APK, served by
 *   Android from local storage. There is nothing to precache and no network to lose.
 * - **A new version arrives as a new package.** The worker's job is to notice one and offer it; here that
 *   is the installer's job, and a button in the page could not perform it. An offer to update that reloads
 *   the page and changes nothing is worse than no offer at all.
 * - **Installing is what the person already did.** `beforeinstallprompt` is Chromium telling a website it
 *   could become an app. It never fires in a WebView, so the offer was dead code rather than a wrong
 *   prompt — but dead code that ships is still code somebody has to read.
 *
 * So the Android bundle carries none of it, and `scripts/build.ts` emits no `sw.js` to go with it. Which
 * implementation a bundle contains is decided by the `capacitor` condition on `#offline` in `package.json`,
 * the same way the transport and the constants are chosen — the alternative, letting registration fail at
 * runtime against a file that is not there, works but leaves the machinery in the package and the
 * behaviour dependent on an error path.
 */

import type { InstallOffer, UpdatePrompt } from "./prompt.ts";

export type { InstallOffer, UpdatePrompt };

/**
 * Do nothing, and report no problem.
 *
 * `null` is the "nothing went wrong" answer, which is accurate: there is no worker to register and its
 * absence is the intended state, not a failure the caller should hear about.
 */
export async function install(_prompt: UpdatePrompt): Promise<string | null> {
  return null;
}

/** Do nothing. The event this would wait for is not fired in a WebView. */
export function offerInstall(_offer: InstallOffer): void {}
