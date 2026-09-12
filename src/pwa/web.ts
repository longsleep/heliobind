/**
 * Installing the app, keeping it working offline, and offering it a newer self.
 *
 * ## Offline is the point, not a bonus
 *
 * The device this app configures is usually the reason the network is unreliable — it is being joined to a
 * Wi-Fi it cannot yet reach, or it is on a balcony at the edge of coverage. So the app is precached whole
 * and served from that cache. The network is consulted to *discover* a new version and for nothing else.
 *
 * ## Updating is offered, never imposed
 *
 * A waiting worker could take over the moment it installs. It must not: a sweep of 146 parameters takes
 * minutes over Bluetooth, and reloading half way through discards every reading. So a new version installs,
 * waits, and says so; the page swaps only when the button is pressed.
 *
 * The reload happens on `controllerchange` rather than immediately after the message, because that event is
 * the browser confirming the new worker is in charge. Reloading first would race it and could load the old
 * app again from the old cache.
 *
 * ## Installing is offered, and asked at most once a month
 *
 * Installed, the app starts from its own cache and needs no network — the state it is meant to be used in,
 * since the device is usually being joined to a Wi-Fi nothing present can reach. So the offer is made
 * rather than left to the address bar, where nobody looks.
 *
 * Chromium is the only engine that reports installability, and the only one that matters: Firefox and
 * Safari have no Web Bluetooth either, so the app has already refused to run there.
 */

import type { InstallOffer, UpdatePrompt } from "./prompt.ts";

export type { InstallOffer, UpdatePrompt };

/**
 * The event Chromium fires when the app meets its installability criteria.
 *
 * Declared here because the DOM type library has no name for it: it is a Chromium extension rather than a
 * standard, and this app is the only place that cares.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
    appinstalled: Event;
  }
}

/** Set once a reload has been triggered, so a controller change cannot start a second one. */
let reloading = false;

/**
 * Whether the app is already running as an installed app rather than in a browser tab.
 *
 * Three display modes, because a desktop install can land in any of them and only a tab should be offered
 * an install. Chromium does not fire the event for an installed app anyway; this is the belt to that
 * braces, and covers the same app being open in a tab beside its installed window.
 */
function standalone(): boolean {
  const modes = ["standalone", "minimal-ui", "window-controls-overlay"];
  return modes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

/**
 * Offer the install when the browser says one is possible.
 *
 * Must be called synchronously at start-up. `beforeinstallprompt` can arrive before anything awaited has
 * settled, and a listener attached after it has fired never hears it — the event is not replayed, so a late
 * listener means an offer that silently never appears.
 */
export function offerInstall(offer: InstallOffer): void {
  // Single use: once prompted the event is spent. Chromium fires a fresh one on a later load if the app is
  // still not installed, which is what makes a refusal recoverable without any state of our own.
  let pending: BeforeInstallPromptEvent | null = null;

  const ask = async (event: BeforeInstallPromptEvent): Promise<void> => {
    await event.prompt();
    const { outcome } = await event.userChoice;
    // Dismissing the browser's own dialog is a refusal as much as pressing Not now, and worth remembering
    // for the same reason: a bar that returns on the next load has just been told no.
    if (outcome === "dismissed") offer.declined();
  };

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppresses Chromium's mini-infobar, which would otherwise make the same offer in its own words.
    event.preventDefault();
    if (standalone()) return;
    pending = event;
    offer.show();
  });

  // Fires for an install started from the browser's own menu too, so the bar cannot outlive what it offers.
  window.addEventListener("appinstalled", () => {
    pending = null;
    offer.hide();
  });

  offer.onAccept(() => {
    const event = pending;
    pending = null;
    offer.hide();
    if (event) void ask(event);
  });
}

/**
 * Register the worker, check for a newer version, and offer it when one arrives.
 *
 * Safe to call when service workers are unavailable or the worker is missing — the development server
 * serves no `sw.js`, and the app must run there unchanged. Failure is reported to the caller rather than
 * thrown: an app that works offline is better than one that refuses to start because it cannot.
 */
export async function install(prompt: UpdatePrompt): Promise<string | null> {
  if (!("serviceWorker" in navigator)) {
    return "this browser does not support offline use";
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  prompt.onAccept(() => {
    // The worker acts only when told, and this is the whole of the instruction set.
    registration.waiting?.postMessage("take-over");
  });

  const offer = (worker: ServiceWorker | null): void => {
    // `controller` is null on the very first visit, when the worker that just installed is not replacing
    // anything. There is nothing to update *to* in that case, and offering would be nonsense.
    if (worker?.state === "installed" && navigator.serviceWorker.controller) prompt.show();
  };

  offer(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    installing?.addEventListener("statechange", () => offer(installing));
  });

  // The check on start. Registration alone does not guarantee one: the browser may serve the worker script
  // from its own cache, and a long-lived installed app might otherwise never look.
  try {
    await registration.update();
  } catch {
    // Offline, which is exactly the case this app is built for. The installed version keeps working.
  }
  return null;
}
