/**
 * The constants this project does not ship, kept where the person who supplied them can find them again.
 *
 * The Bluetooth interface needs three values that come from the vendor application: a cipher key, a cipher
 * IV, and the handshake key a device is greeted with. They are not in this repository and never will be —
 * the same values open any device of the same family within radio range, and publishing them would hand
 * that out to people who have no business with the battery next door.
 *
 * So they are typed in once and remembered. `localStorage` because it is the browser's own store, it
 * survives the app being closed and reinstalled as a PWA, and it never leaves the device — this app makes
 * no network requests at all, which its content security policy enforces rather than promises.
 *
 * That does mean the values sit in the browser profile of whoever entered them. On a personal phone that is
 * the right place; on a shared machine it is worth clearing them.
 */

/** One stored value, and where it lives. */
const STORE = {
  cipherKey: "heliobind.cipher.key",
  cipherIv: "heliobind.cipher.iv",
  bindKey: "heliobind.bind.key",
} as const;

export type Field = keyof typeof STORE;

/** Everything the app needs supplied, empty where it has not been. */
export interface Secrets {
  cipherKey: string;
  cipherIv: string;
  bindKey: string;
}

/**
 * Read what was stored.
 *
 * A browser can refuse `localStorage` outright — private windows, storage disabled, an embedded webview —
 * and that is a reason to start with empty fields rather than to fail to start.
 */
export function load(): Secrets {
  return {
    cipherKey: read("cipherKey"),
    cipherIv: read("cipherIv"),
    bindKey: read("bindKey"),
  };
}

/** Remember one value, or forget it when blank. */
export function save(field: Field, value: string): void {
  try {
    if (value) {
      localStorage.setItem(STORE[field], value);
    } else {
      localStorage.removeItem(STORE[field]);
    }
  } catch {
    // Storage unavailable or full. The value still works for this session, which is the part that matters.
  }
}

/** Forget all three. Offered because a shared machine should not keep them. */
export function forget(): void {
  for (const key of Object.values(STORE)) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to do: if it cannot be removed it was almost certainly never stored.
    }
  }
}

function read(field: Field): string {
  try {
    return localStorage.getItem(STORE[field]) ?? "";
  } catch {
    return "";
  }
}
