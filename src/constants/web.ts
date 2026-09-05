/**
 * What a browser build was given, which is whatever the bundler compiled in.
 *
 * `settings.ts` already reads the three `BUN_PUBLIC_HELIOBIND_*` substitutions directly, so there is
 * nothing to fetch here and this exists to give the native half something to be the other side of.
 */

import type { Secrets } from "../settings.ts";

/** Nothing beyond what is already compiled in. */
export async function supplied(): Promise<Partial<Secrets>> {
  return {};
}
