/**
 * That the page and the code agree about element ids.
 *
 * `dom` resolves every id at import time and throws on the first one missing, so a rename in `index.html`
 * without the matching rename here does not fail a type check, does not fail a unit test, and does not fail
 * until the page is opened — where it takes the whole app down before anything renders.
 *
 * That happened: a button was renamed and its lookup was left behind. Both files are read as text rather
 * than imported, because importing `view.ts` needs a DOM and the point is to check the pair without one.
 */

import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../../index.html", import.meta.url)).text();
const view = await Bun.file(new URL("./view.ts", import.meta.url)).text();

/** Every id `view.ts` resolves through `el(...)`. */
function looked_up(): string[] {
  return [...view.matchAll(/\bel(?:<[^>]*>)?\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
}

/** Every id the page defines. */
function defined(): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? ""));
}

describe("the page and the code", () => {
  test("view.ts resolves ids, and this test can see them", () => {
    // A guard on the test itself: a change to how `dom` is written could make the regex match nothing, and
    // a test that checks an empty list passes for the wrong reason.
    expect(looked_up().length).toBeGreaterThan(10);
    expect(defined().size).toBeGreaterThan(10);
  });

  test("every id the code resolves exists in the page", () => {
    const missing = looked_up().filter((id) => !defined().has(id));
    expect(missing).toEqual([]);
  });

  test("no id is resolved twice", () => {
    const ids = looked_up();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
