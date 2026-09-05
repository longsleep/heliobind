/**
 * What a transport must provide, and everything about this device that is true whichever radio reaches it.
 *
 * Two implementations sit beside this file — `web.ts` over Web Bluetooth, `native.ts` over the Android
 * plugin — and the build picks one. Neither is imported from here: this module must stay loadable by a
 * bundle that will contain only the other, which is what keeps Android code out of the web build.
 *
 * The protocol modules do not import this either. They are pure functions over bytes, and that separation
 * is what lets them be tested without a device.
 */

import { type Bytes, declaredLength, looksLikeFrame } from "../protocol/frame.ts";

/** Vendor service. Needed to reach the characteristics, and on its own not distinctive — see {@link VENDOR}. */
export const SERVICE = 0x00ff;

/**
 * The vendor's manufacturer-data marker, and the reason a chooser can tell this family apart.
 *
 * {@link SERVICE} identifies nothing: `0x00FF` is the UUID from Espressif's `gatt_server_service_table`
 * example, which this firmware is built from, so every unrelated ESP32 project built from the same example
 * advertises it too. Filtering on the service alone offers those as candidates.
 *
 * The manufacturer data is ASCII rather than binary — `G:72#0HVR`, being a device-type code and the first
 * four characters of the serial. A Bluetooth stack reads the leading two octets as a little-endian company
 * identifier, so `47 3a` — `G:` — becomes `0x3A47`, a value far outside the assigned range that no real
 * vendor holds. Phantom or not, it is a stable two-octet marker every device of the family emits, and it
 * is what makes a filter selective.
 *
 * What is deliberately *not* matched is the device-type code that follows, so an unannounced model of the
 * family is still offered rather than silently excluded.
 */
export const VENDOR = 0x3a47;

/**
 * The UUIDs, spelled out. Web Bluetooth accepts a 16-bit number for the service, but the characteristics
 * of this service are not in the assigned range, so they need full form — and the Android plugin wants the
 * long form throughout.
 */
export const UUID = {
  service: "000000ff-0000-1000-8000-00805f9b34fb",
  /** Read, write and notify. The command channel. */
  io: "0000ff01-0000-1000-8000-00805f9b34fb",
  /** Read-only. Returns a short constant. */
  info: "0000ff02-0000-1000-8000-00805f9b34fb",
  /** The vendor's second write target, write-without-response. Purpose unestablished. */
  ff04: "0000ff04-0000-1000-8000-00805f9b34fb",
} as const;

/** How long to wait for a reply before giving up. */
export const REPLY_TIMEOUT_MS = 5_000;

/** Where and how to write, for the diagnostics in {@link Link.requestVia}. */
export interface Route {
  readonly characteristic: "io" | "ff04";
  readonly withoutResponse: boolean;
}

export class BleError extends Error {}

/**
 * One open connection to one device.
 *
 * The contract `device.ts` and the interface depend on, and the whole of what a transport has to implement.
 * Nothing above this line knows whether the bytes travel through a browser or through Android.
 */
export interface Link {
  /** What to call the device on screen. The advertised name, which is the tail of the serial. */
  readonly name: string;
  /**
   * What carried this connection, for the record.
   *
   * Worth a line in the log because the two transports fail differently, and the negotiated MTU decides
   * whether a frame arrives whole: this device does not reassemble a split write, so a small MTU is a
   * silent failure rather than an error.
   */
  readonly describe: string;
  /**
   * Called for every notification the device sends, whenever it sends one.
   *
   * Separate from the reply collection in {@link request} on purpose: it also catches what arrives
   * unprompted, which is the only way to tell "the device said nothing" apart from "the device said
   * something we failed to assemble". The first notification after subscribing is usually the Espressif
   * example's counter, `00 01 02 … 0e`, which means the transport works and the vendor firmware never
   * replaced that handler.
   */
  onNotification: ((data: Bytes) => void) | null;
  /** Called once when the device goes away, however it went. */
  onDisconnected: (() => void) | null;
  readonly connected: boolean;
  close(): Promise<void>;
  /**
   * Read the informational characteristic, which returns a short constant.
   *
   * Useful as a liveness check: it needs no framing, no cipher and no CRC, so a failure here is a transport
   * problem rather than a protocol one.
   */
  readInfo(): Promise<Bytes>;
  /** Send a frame and wait for the reply. */
  request(frame: Bytes): Promise<Bytes>;
  /** Send a frame by a route other than the default, and report the reply. */
  requestVia(frame: Bytes, route: Route): Promise<Bytes>;
}

/**
 * Collect notification fragments into one frame.
 *
 * **Replies arrive in pieces.** The first two octets of the first fragment declare the total; fragments
 * accumulate until it is satisfied. Not everything the device sends is a reply, so anything that cannot be
 * a frame is discarded and the wait continues — the firmware's leftover counter would otherwise be
 * assembled into something that fails to parse, and the real answer arrive too late to be recognised.
 *
 * Transport-independent on purpose: both implementations subscribe differently and reassemble identically,
 * and this behaviour was learned the hard way rather than designed.
 *
 * `subscribe` is given the fragment handler and returns the way to stop listening.
 */
export function assemble(subscribe: (fragment: (data: Bytes) => void) => () => void): Promise<Bytes> {
  return new Promise<Bytes>((resolve, reject) => {
    let buffer = new Uint8Array(0) as Bytes;

    const done = (outcome: () => void) => {
      clearTimeout(timer);
      unsubscribe();
      outcome();
    };

    const timer = setTimeout(() => {
      done(() =>
        reject(
          new BleError(
            buffer.length === 0
              ? "no reply within the timeout"
              : `reply incomplete: ${buffer.length} octets after the timeout`,
          ),
        ),
      );
    }, REPLY_TIMEOUT_MS);

    const unsubscribe = subscribe((fragment) => {
      const grown = new Uint8Array(buffer.length + fragment.length) as Bytes;
      grown.set(buffer, 0);
      grown.set(fragment, buffer.length);
      buffer = grown;

      if (looksLikeFrame(buffer) === false) {
        buffer = new Uint8Array(0) as Bytes;
        return;
      }

      const total = declaredLength(buffer);
      if (total !== null && buffer.length >= total) {
        done(() => resolve(buffer.subarray(0, total) as Bytes));
      }
    });
  });
}
