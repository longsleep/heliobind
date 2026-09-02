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

describe("the batch control", () => {
  /** The `value` of every option inside `<select id="batch">`. */
  function offered(): string[] {
    const select = /<select id="batch">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    return [...select.matchAll(/value="([^"]*)"/g)].map((match) => match[1] ?? "");
  }

  test("every offered batch size is a positive integer", () => {
    const sizes = offered();
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) {
      expect(Number.isInteger(Number(size))).toBe(true);
      expect(Number(size)).toBeGreaterThanOrEqual(1);
    }
  });

  test("the default is a size confirmed to answer completely", () => {
    // The selected option decides what a reader who touches nothing gets, so it may not drift to whatever
    // option happens to come first in the markup, and it may not exceed what has been measured.
    const selected = /<option value="(\d+)" selected>/.exec(html)?.[1];
    expect(selected).toBeDefined();
    expect(Number(selected)).toBeLessThanOrEqual(16);
    expect(offered()).toContain("1");
  });
});
