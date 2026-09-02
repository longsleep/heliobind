/**
 * What the device chooser offers.
 *
 * `choose` is a single call into the browser, but *what it asks for* decides which hardware a person is
 * invited to connect to — and getting that wrong is not a crash, it is a chooser listing somebody else's
 * equipment. The browser is stubbed because the filter is the whole subject here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { choose, SERVICE, VENDOR } from "./ble.ts";

const original = Reflect.getOwnPropertyDescriptor(globalThis, "navigator");

/** Stand in for the browser, capturing the options `choose` asks with. */
function stubChooser(): { asked: () => BluetoothLEScanFilter[] | undefined; options: () => unknown } {
  let seen: RequestDeviceOptions | undefined;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      bluetooth: {
        requestDevice(options: RequestDeviceOptions) {
          seen = options;
          return Promise.resolve({} as BluetoothDevice);
        },
      },
    },
  });
  return {
    asked: () => (seen && "filters" in seen ? seen.filters : undefined),
    options: () => seen,
  };
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("choosing a device", () => {
  test("asks for the vendor marker as well as the service", async () => {
    // The service alone is Espressif's example UUID, which unrelated ESP32 hardware also advertises. Both
    // conditions in one filter object means both must match; two objects would mean either.
    const chooser = stubChooser();
    await choose();

    const filters = chooser.asked();
    expect(filters).toHaveLength(1);
    expect(filters?.[0]?.services).toEqual([SERVICE]);
    expect(filters?.[0]?.manufacturerData).toEqual([{ companyIdentifier: VENDOR }]);
  });

  test("does not filter on the device-type code", async () => {
    // `G:72#` names this model. The vendor application matches an allowlist of five codes; this app
    // deliberately does not, so an unannounced model of the family is still offered.
    const chooser = stubChooser();
    await choose();

    expect(chooser.asked()?.[0]?.manufacturerData?.[0]).not.toHaveProperty("dataPrefix");
  });

  test("still declares the service so it may be reached after connecting", async () => {
    // Matching an advertisement grants no access: without this, getPrimaryService is refused.
    const chooser = stubChooser();
    await choose();

    expect(chooser.options()).toHaveProperty("optionalServices", [SERVICE]);
  });

  test("refuses where the browser has no Bluetooth at all", async () => {
    Reflect.deleteProperty(globalThis, "navigator");
    expect(choose()).rejects.toThrow(/does not support/);
  });
});
