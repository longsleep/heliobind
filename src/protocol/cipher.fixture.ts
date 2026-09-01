/**
 * Cipher constants for tests.
 *
 * Obviously fake, and deliberately so: this project does not carry the real ones, and no test here depends
 * on them. Every assertion about the cipher is a property of the construction — that CBC with a zero IV is
 * raw block encryption, that a round trip returns what went in — which any valid key satisfies.
 *
 * Imported only by tests, so it never reaches the bundle.
 */

import { configure } from "./crypto.ts";

export const TEST_CIPHER = { key: "0123456789abcdef", iv: "fedcba9876543210" } as const;

/** Call from `beforeAll`. */
export function useTestCipher(): void {
  configure(TEST_CIPHER);
}
