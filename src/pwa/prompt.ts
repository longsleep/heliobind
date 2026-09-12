/**
 * What the interface shows for an update and for an install, described apart from either implementation.
 *
 * Both shapes are the same on the web and in the package; what differs is whether anything ever calls
 * them. They live here so `web.ts` and `native.ts` agree on them without one importing the other.
 */

/** What the page shows and hides when an update is ready. */
export interface UpdatePrompt {
  /** Reveal the offer. Called once, when a newer version has installed and is waiting. */
  show(): void;
  /** Called with the action that performs the update, so the prompt can wire its own button. */
  onAccept(take: () => void): void;
}

/** What the page shows and hides when the app can be installed. */
export interface InstallOffer {
  /** Reveal the offer. Called when the browser reports the app installable. */
  show(): void;
  /** Hide it: taken, refused, or overtaken by an install from the browser's own menu. */
  hide(): void;
  /** Called with the action that prompts, so the offer can wire its own button. */
  onAccept(take: () => void): void;
  /** Called when the browser's own dialog was dismissed, so the refusal can be remembered. */
  declined(): void;
}
