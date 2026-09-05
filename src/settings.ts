/**
 * The constants this project does not ship, kept where the person who supplied them can find them again.
 *
 * The Bluetooth interface needs three values that come from the vendor application: a cipher key, a cipher
 * IV, and the handshake key a device is greeted with. They are not in this repository and never will be:
 * they are credentials, and publishing them would hand out to anyone in radio range what only somebody
 * doing protocol work on their own hardware has a reason to hold.
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

/** Set while a typed handshake key is preferred over the one the build carries. */
const OWN_BIND_KEY = "heliobind.bind.own";

/** Everything the app needs supplied, empty where it has not been. */
export interface Secrets {
  cipherKey: string;
  cipherIv: string;
  bindKey: string;
}

/**
 * Constants a build was given, or empty strings.
 *
 * `BUN_PUBLIC_HELIOBIND_*` is inlined at bundle time, so these are literals by the time a browser sees
 * them — there is no environment to read at runtime. Both paths do it: the build sets `env` in
 * scripts/build.ts, the dev server through `[serve.static]` in bunfig.toml. Unset, the expression is
 * undefined and the app asks instead.
 *
 * It must stay a literal `process.env.NAME`. Bun substitutes that exact shape and nothing else, so hoisting
 * `process.env` into a variable first would silently stop the inlining.
 *
 * A build made with these set carries them in its JavaScript. That is the point when the copy is for your
 * own phone, and the reason not to publish such a build.
 */
const SHIPPED: Secrets = {
  cipherKey: fromBuild(() => process.env.BUN_PUBLIC_HELIOBIND_CIPHER_KEY),
  cipherIv: fromBuild(() => process.env.BUN_PUBLIC_HELIOBIND_CIPHER_IV),
  bindKey: fromBuild(() => process.env.BUN_PUBLIC_HELIOBIND_BIND_KEY),
};

/**
 * One constant a build may have supplied, or an empty string.
 *
 * The `try` is load-bearing. Substitution replaces the expression only when the variable is actually set:
 * unset, `process.env.NAME` survives into the bundle verbatim, and a browser has no `process` to evaluate
 * it against — so the module throws `ReferenceError` while being imported and the app never starts.
 *
 * The build substitutes all three regardless, so this cannot fire there. It fires on the development server,
 * which has no such backstop and is where a fresh clone with no .env.local lands.
 *
 * Passing a function rather than a value is what keeps the read inside the `try`; an argument would be
 * evaluated at the call site and throw before this ran. The literal `process.env.NAME` is preserved either
 * way, so substitution still recognises it.
 */
function fromBuild(read: () => string | undefined): string {
  try {
    return read() ?? "";
  } catch {
    return "";
  }
}

/** Whether this build was given the constants. */
export function shippedWithConstants(): boolean {
  return Boolean(SHIPPED.cipherKey && SHIPPED.cipherIv && SHIPPED.bindKey);
}

/**
 * Whether the build supplied one particular constant.
 *
 * Asked per field rather than for all three, because the interface treats a supplied value differently
 * from a typed one: there is nothing to be gained by displaying back a value that is already inside the
 * build, and something to be lost by putting it on a screen in a place where the device is in range.
 */
export function shipped(field: Field): boolean {
  return Boolean(SHIPPED[field]);
}

/** The handshake key this build carries, if it carries one. */
export function shippedBindKey(): string {
  return SHIPPED.bindKey;
}

/**
 * Whether to greet devices with the key this build carries, rather than one that was typed.
 *
 * A remembered choice rather than a derived one. What a device is greeted with is a property of that
 * device, and a build that carries a handshake key has no way to know it is the right one for the device
 * in front of somebody — so the key it carries is offered rather than imposed.
 */
export function usingShippedBindKey(): boolean {
  if (!SHIPPED.bindKey) return false;
  try {
    // Absent means never answered, and the default is to use what the build came with: it is the reason
    // the build carries it, and the fold below offers the way out.
    return localStorage.getItem(OWN_BIND_KEY) === null;
  } catch {
    return true;
  }
}

/** Remember whether the build's own handshake key is in use. */
export function useShippedBindKey(shippedKey: boolean): void {
  try {
    if (shippedKey) localStorage.removeItem(OWN_BIND_KEY);
    else localStorage.setItem(OWN_BIND_KEY, "1");
  } catch {
    // Storage unavailable. The choice holds for this session, which is the part that matters.
  }
}

/**
 * Read what was stored, falling back to whatever the build carried.
 *
 * A browser can refuse `localStorage` outright — private windows, storage disabled, an embedded webview —
 * and that is a reason to fall back rather than to fail to start.
 */
export function load(): Secrets {
  // What was typed wins over what the build carried: a stored value is a deliberate act by whoever is
  // holding the phone, and a build default is a convenience for the common case.
  return {
    cipherKey: read("cipherKey") || SHIPPED.cipherKey,
    cipherIv: read("cipherIv") || SHIPPED.cipherIv,
    // Deliberately not falling back to what the build carries. A handshake key the build supplies is
    // used through {@link usingShippedBindKey} and never put in the field, so that unticking the box
    // asks for a key rather than revealing the one it was hiding.
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

/**
 * Forget all three.
 *
 * Only what was typed. A build given the constants still has them compiled in, and clearing the fields
 * cannot take them out of the JavaScript — which is worth knowing before treating this as a way to hand
 * the phone to someone.
 */
export function forget(): void {
  for (const key of Object.values(STORE)) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to do: if it cannot be removed it was almost certainly never stored.
    }
  }
}

/**
 * When the install offer was last refused.
 *
 * Kept beside the constants rather than in `pwa.ts` because this module is the one place that knows
 * `localStorage` can refuse outright, and a second copy of that guard is a second thing to get wrong.
 * `forget()` deliberately leaves it: clearing the constants is about values someone typed, not about a bar
 * they waved away.
 */
const REFUSED_INSTALL = "heliobind.install.refused";

/**
 * How long a refusal stands.
 *
 * Long enough not to nag, short enough that someone who declined on a desktop is asked again on the phone
 * they actually stand at the device with.
 */
export const ASK_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether an offer refused at `refusedAt` may be made again at `now`. Zero means it never was.
 *
 * Pure, and separate from the store, so the policy can be tested without a browser. A stored time in the
 * future counts as due: the alternative is that a clock correction silences the offer permanently.
 */
export function dueAgain(refusedAt: number, now: number): boolean {
  if (refusedAt <= 0 || refusedAt > now) return true;
  return now - refusedAt >= ASK_AGAIN_AFTER_MS;
}

/** Whether the install offer may be shown, given the time now. */
export function mayOfferInstall(now: number): boolean {
  return dueAgain(refusedInstall(), now);
}

/** Remember that the offer was refused, so it is not repeated for a month. */
export function refuseInstall(now: number): void {
  try {
    localStorage.setItem(REFUSED_INSTALL, String(now));
  } catch {
    // Storage unavailable. The bar is hidden for this session regardless, and asking again next time is a
    // better failure than never asking.
  }
}

function refusedInstall(): number {
  try {
    const stored = Number(localStorage.getItem(REFUSED_INSTALL));
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    return 0;
  }
}

function read(field: Field): string {
  try {
    return localStorage.getItem(STORE[field]) ?? "";
  } catch {
    return "";
  }
}
