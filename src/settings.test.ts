/**
 * That the install offer asks again, and does not nag.
 *
 * Only the policy is tested, not the store around it: `localStorage` is the browser's and this runs without
 * one. `dueAgain` is separate from the store for exactly that reason — the decision is the part that can be
 * got wrong in a way nobody notices, since both failures are invisible. Too eager is a bar on every load;
 * too shy is a bar that never returns.
 */

import { describe, expect, test } from "bun:test";
import { ASK_AGAIN_AFTER_MS, dueAgain } from "./settings.ts";

/** An arbitrary fixed instant, so nothing here depends on the clock. */
const NOW = 1_800_000_000_000;

describe("the install offer", () => {
  test("is due when it has never been refused", () => {
    expect(dueAgain(0, NOW)).toBe(true);
  });

  test("is not due the moment after a refusal", () => {
    expect(dueAgain(NOW, NOW + 1)).toBe(false);
  });

  test("is not due a day short of the month", () => {
    expect(dueAgain(NOW, NOW + ASK_AGAIN_AFTER_MS - 1)).toBe(false);
  });

  test("is due once the month has passed", () => {
    expect(dueAgain(NOW, NOW + ASK_AGAIN_AFTER_MS)).toBe(true);
  });

  test("asks again rather than never, when the clock has moved back", () => {
    // A refusal stamped in the future is not a refusal from the future: the clock was corrected, or the
    // profile came from a machine set wrong. Staying silent would be permanent.
    expect(dueAgain(NOW + ASK_AGAIN_AFTER_MS, NOW)).toBe(true);
  });

  test("is a month, in the units the browser counts in", () => {
    expect(ASK_AGAIN_AFTER_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
