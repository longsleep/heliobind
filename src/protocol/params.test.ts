import { describe, expect, test } from "bun:test";
import {
  ACCESSORY_LIST_LAN,
  batches,
  DEVICE_TYPE,
  DHCP_DISABLED,
  everyChoice,
  everyParam,
  GROUPS,
  HW_VERSION,
  label,
  describe as name,
  numbersOf,
  PARAM_SPACE_LAST,
  PARAMS,
  PROTOCOL_VERSION,
  PROVISIONING,
  RESTART,
  SDK_VERSION,
  SW_VERSION,
  WRITABLE,
  WRITABLE_ALONE,
} from "./params.ts";

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
    expect(name(76)).toBe("wifi_signal");
    expect(name(4)).toBe("data_interval");
  });

  test("matches the specification, so a Bluetooth reading is comparable with a network one", () => {
    // Appendix C is the authority, and the bridge publishes the same strings. A reading taken over
    // Bluetooth has to be comparable with the same reading taken over the network, unaided.
    expect(name(17)).toBe("server_address");
    expect(name(54)).toBe("ble_handshake_key");
    expect(name(57)).toBe("wifi_password");
  });

  test("falls back to the convention the rest of the project uses", () => {
    // `unknown_<n>`, matching the specification's Appendix C and what the bridge publishes. A reading taken
    // over Bluetooth should be comparable with the same reading taken over the network, unaided.
    expect(name(0)).toBe("unknown_0");
    expect(name(98)).toBe("unknown_98");
    expect(name(PARAM_SPACE_LAST)).toBe(`unknown_${PARAM_SPACE_LAST}`);
  });
});

describe("naming a value", () => {
  test("names the product a device type code stands for", () => {
    // 72 is the code the reference device holds, and the one its Bluetooth advertisement carries.
    expect(label(13, "72")).toBe("NEXA 2000");
    expect(label(13, "61")).toBe("NOAH 2000");
    expect(label(13, "73")).toBe("AURA/NODE 5000");
    expect(label(13, "83")).toBe("VETA 2200");
  });

  test("ignores space around a value, whose shape the device does not promise", () => {
    expect(label(13, " 72 ")).toBe("NEXA 2000");
  });

  test("leaves a code it has not been taught unnamed rather than guessing", () => {
    // Shown as the device sent it. A product this build predates is still worth reading.
    expect(label(13, "99")).toBeUndefined();
    expect(label(13, "")).toBeUndefined();
  });

  test("has nothing to say about a parameter that carries a quantity or text", () => {
    expect(label(76, "-62")).toBeUndefined();
    expect(label(20, "GTSW0000")).toBeUndefined();
    expect(label(0, "72")).toBeUndefined();
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

  test("the provisioning read says what the device is and what it runs", () => {
    // Which product, and every version the configuration space carries — the questions a support thread
    // opens with, and the reason not to have to follow a provisioning read with a second one.
    const numbers = numbersOf(PROVISIONING);
    expect(numbers).toContain(DEVICE_TYPE.number);
    for (const version of [SW_VERSION, HW_VERSION, SDK_VERSION, PROTOCOL_VERSION]) {
      expect(numbers).toContain(version.number);
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

/**
 * That a flag offered as a checkbox writes what it says it writes.
 *
 * The whole risk in a checkbox is polarity. A box labelled for the reader but wired to the parameter's
 * negative sense would tick "on" and write "off", and neither the interface nor the device would complain —
 * the device would simply be addressed the other way round from what somebody chose.
 */
describe("a flag offered as a checkbox", () => {
  test("is a parameter this app may write", () => {
    for (const param of PARAMS) {
      if (param.toggle) expect(param.writable).toBe(true);
    }
  });

  test("has two distinct values, both of them explained by its labels", () => {
    for (const param of PARAMS) {
      if (!param.toggle) continue;
      expect(param.toggle.on).not.toBe(param.toggle.off);
      expect(param.labels?.[param.toggle.on]).toBeString();
      expect(param.labels?.[param.toggle.off]).toBeString();
    }
  });

  test("ticking the DHCP flag disables DHCP, as its name says", () => {
    expect(DHCP_DISABLED.toggle?.on).toBe("1");
    expect(DHCP_DISABLED.toggle?.off).toBe("0");
    expect(DHCP_DISABLED.labels?.["1"]).toBe("static");
  });
});

/**
 * That the single-setting field offers what nothing else does, and only that.
 *
 * Offering a grouped parameter there as well would be a way to write half a group — a network name with no
 * passphrase, a static address with no flag selecting it — which is exactly what the groups exist to make
 * impossible.
 */
describe("the settings written one at a time", () => {
  test("leave out everything a group already carries", () => {
    const grouped = new Set(GROUPS.flatMap((group) => group.params.map((param) => param.number)));
    for (const param of WRITABLE_ALONE) {
      expect(grouped.has(param.number)).toBe(false);
    }
  });

  test("leave out the restart, which is a button rather than a value", () => {
    expect(WRITABLE_ALONE).not.toContain(RESTART);
  });

  test("are the accessory list, and nothing else", () => {
    expect(WRITABLE_ALONE).toEqual([ACCESSORY_LIST_LAN]);
  });

  test("account for every writable parameter between them", () => {
    const offered = new Set([
      ...WRITABLE_ALONE.map((param) => param.number),
      ...GROUPS.flatMap((group) => group.params.map((param) => param.number)),
      RESTART.number,
    ]);
    // Nothing writable may be unreachable from the interface: a parameter on the allowlist that no control
    // offers is a permission granted to nobody, and a sign the two lists have drifted.
    for (const param of WRITABLE) {
      expect(offered.has(param.number)).toBe(true);
    }
  });
});
