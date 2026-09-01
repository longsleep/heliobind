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
 */

/** What the page shows and hides when an update is ready. */
export interface UpdatePrompt {
  /** Reveal the offer. Called once, when a newer version has installed and is waiting. */
  show(): void;
  /** Called with the action that performs the update, so the prompt can wire its own button. */
  onAccept(take: () => void): void;
}

/** Set once a reload has been triggered, so a controller change cannot start a second one. */
let reloading = false;

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
