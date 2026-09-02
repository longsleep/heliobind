import { describe, expect, test } from "bun:test";
import { batches, everyChoice, everyParam, describe as name, PARAM_SPACE_LAST, PARAMS } from "./params.ts";

describe("the parameter space", () => {
  test("runs from zero to the last one inclusive", () => {
    const all = everyParam();
    expect(all.length).toBe(PARAM_SPACE_LAST + 1);
    expect(all[0]).toBe(0);
    expect(all.at(-1)).toBe(PARAM_SPACE_LAST);
  });

  test("is 146 parameters", () => {
    // Two unrelated methods agree on this: a compile-time loop bound in the firmware, and a device that
    // answered on 0-145 and on nothing above. A change here should come from evidence, not from a hunch.
    expect(everyParam().length).toBe(146);
  });

  test("names no parameter twice", () => {
    // Part of the table is generated and the rest is hand-written, so a collision is a plausible mistake
    // rather than a theoretical one. `lookup` takes the first match, which would silently shadow the other.
    const numbers = PARAMS.map((param) => param.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    const names = PARAMS.map((param) => param.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the generated connection-event slots cover 124 to 138", () => {
    const slots = PARAMS.filter((param) => param.name.startsWith("connection_event_"));
    expect(slots.map((slot) => slot.number)).toEqual(Array.from({ length: 15 }, (_, index) => 124 + index));
    expect(slots.at(0)?.name).toBe("connection_event_00");
    expect(slots.at(-1)?.name).toBe("connection_event_14");
  });

  test("contains every parameter this app claims to know", () => {
    // A documented parameter outside the space would be a transcription error, and its reads would go
    // unanswered forever with nothing to say why.
    for (const param of PARAMS) {
      expect(param.number).toBeGreaterThanOrEqual(0);
      expect(param.number).toBeLessThanOrEqual(PARAM_SPACE_LAST);
    }
  });
});

describe("naming a parameter", () => {
  test("uses the established name where there is one", () => {
    expect(name(17)).toBe("server_address");
    expect(name(76)).toBe("wifi_signal");
  });

  test("falls back to the convention the rest of the project uses", () => {
    // `unknown_<n>`, matching the specification's Appendix C and what the bridge publishes. A reading taken
    // over Bluetooth should be comparable with the same reading taken over the network, unaided.
    expect(name(0)).toBe("unknown_0");
    expect(name(98)).toBe("unknown_98");
    expect(name(PARAM_SPACE_LAST)).toBe(`unknown_${PARAM_SPACE_LAST}`);
  });
});

describe("what the app can offer to read", () => {
  test("offers the whole space, not only the named parameters", () => {
    // Offering PARAMS alone left two thirds of the space unreachable, 145 among them — the one register
    // that answers differently from every other, and so the one most worth being able to ask for.
    const choices = everyChoice();
    expect(choices.length).toBe(PARAM_SPACE_LAST + 1);
    expect(choices.map((choice) => choice.number)).toEqual(everyParam());
    expect(choices.length).toBeGreaterThan(PARAMS.length);
  });

  test("every choice carries a name and a summary", () => {
    for (const choice of everyChoice()) {
      expect(choice.name).toBe(name(choice.number));
      expect(choice.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("batching a read", () => {
  test("covers every parameter exactly once, in order", () => {
    const all = everyParam();
    for (const size of [1, 2, 8, 100, 1000]) {
      expect(batches(all, size).flat()).toEqual(all);
    }
  });

  test("groups to the requested size, with a short last group", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("a size of one is a request per parameter", () => {
    expect(batches([7, 8, 9], 1)).toEqual([[7], [8], [9]]);
  });

  test("a size larger than the input is one group", () => {
    expect(batches([7, 8], 64)).toEqual([[7, 8]]);
  });

  test("a nonsensical size still makes progress", () => {
    // Rather than loop forever on a zero step, or drop parameters on a fractional one. The size arrives
    // from a text field eventually, and a UI should not be the thing that makes this safe.
    expect(batches([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(batches([1, 2, 3], -5)).toEqual([[1], [2], [3]]);
    expect(batches([1, 2, 3], 2.7)).toEqual([[1, 2], [3]]);
  });

  test("nothing in, nothing out", () => {
    expect(batches([], 8)).toEqual([]);
  });
});
