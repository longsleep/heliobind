/**
 * Web Bluetooth transport.
 *
 * Everything specific to the browser's Bluetooth API lives here. The protocol modules are pure functions
 * over bytes and must not import this file — that separation is what makes them testable without a device.
 *
 * Two facts shape the design:
 *
 * - **MTU is not exposed.** Web Bluetooth negotiates it and does not say what it got. Frames are written
 *   whole regardless, because the device does not reassemble split writes — see {@link Connection.write}.
 * - **Replies arrive in pieces.** Notifications carry fragments; the first two octets of the first fragment
 *   declare the total. {@link Connection.request} accumulates until that total is satisfied.
 */

import { type Bytes, declaredLength, looksLikeFrame } from "../protocol/frame.ts";

/** Vendor service. Needed to reach the characteristics, and on its own not distinctive — see {@link VENDOR}. */
export const SERVICE = 0x00ff;

/**
 * The vendor's manufacturer-data marker, and the reason the chooser can tell this family apart.
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
 * This is the same test the vendor application makes. It walks the scan record itself, keeps the
 * manufacturer-data field whose ASCII begins `g:` and the complete local name, and joins them into the
 * serial — so filtering on those two octets is its prefix check expressed as a company identifier.
 *
 * What is deliberately *not* matched is the device-type code that follows. The application compares it
 * against an allowlist — `g:61` NOAH 2000, `g:66` GroPlug, `g:72` NEXA 2000, `g:73` AURA 5000, `g:83`
 * VETA 2000 — and this app has no reason to be that particular: the configuration space is common to the
 * family, and an unannounced model should still be offered rather than silently excluded.
 */
export const VENDOR = 0x3a47;

/**
 * The UUIDs, spelled out. Web Bluetooth accepts a 16-bit number for the service, but the characteristics
 * of this service are not in the assigned range, so they need full form.
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
const REPLY_TIMEOUT_MS = 5_000;

/** Where and how to write, for the diagnostics in {@link Connection.requestVia}. */
export interface Route {
  readonly characteristic: "io" | "ff04";
  readonly withoutResponse: boolean;
}

export class BleError extends Error {}

/** Whether this browser can do any of this at all. */
export function isSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/**
 * Ask the user to choose a device.
 *
 * Must be called from a user gesture; the browser shows its own chooser and the page never sees devices the
 * user did not pick. The chooser displays the advertised name, which is the tail of the serial.
 *
 * Both conditions have to hold: the service to reach the characteristics, and the manufacturer-data marker
 * to make the offer specific. Requiring only the service listed foreign hardware that shares Espressif's
 * example UUID — see {@link VENDOR}.
 *
 * `optionalServices` is still needed after the filter: matching an advertisement grants nothing, and the
 * service must be declared for `getPrimaryService` to be allowed to reach it.
 */
export async function choose(): Promise<BluetoothDevice> {
  if (!isSupported()) throw new BleError("this browser does not support Web Bluetooth");
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE], manufacturerData: [{ companyIdentifier: VENDOR }] }],
    optionalServices: [SERVICE],
  });
}

/** An open connection to one device. */
export class Connection {
  /**
   * Called for every notification the device sends, whenever it sends one.
   *
   * Separate from the reply collection in {@link request} on purpose: it also catches what arrives
   * unprompted, which is the only way to tell "the device said nothing" apart from "the device said
   * something we failed to assemble". The first notification after subscribing is usually the Espressif
   * example's counter, `00 01 02 … 0e`, which means the transport works and the vendor firmware never
   * replaced that handler.
   */
  onNotification: ((data: Bytes) => void) | null = null;

  private constructor(
    readonly device: BluetoothDevice,
    private readonly io: BluetoothRemoteGATTCharacteristic,
  ) {}

  static async open(device: BluetoothDevice): Promise<Connection> {
    const gatt = device.gatt;
    if (!gatt) throw new BleError("device exposes no GATT server");

    const server = await gatt.connect();
    const service = await server.getPrimaryService(UUID.service);
    const io = await service.getCharacteristic(UUID.io);

    const connection = new Connection(device, io);
    io.addEventListener("characteristicvaluechanged", () => {
      const value = io.value;
      if (value) connection.onNotification?.(new Uint8Array(value.buffer.slice(0)) as Bytes);
    });
    await io.startNotifications();
    return connection;
  }

  get connected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  async close(): Promise<void> {
    if (this.connected) this.device.gatt?.disconnect();
  }

  /**
   * Read the informational characteristic, which returns a short constant.
   *
   * Useful as a liveness check: it needs no framing, no cipher and no CRC, so a failure here is a transport
   * problem rather than a protocol one.
   */
  async readInfo(): Promise<Bytes> {
    const service = await this.device.gatt?.getPrimaryService(UUID.service);
    if (!service) throw new BleError("not connected");
    const characteristic = await service.getCharacteristic(UUID.info);
    const value = await characteristic.readValue();
    return new Uint8Array(value.buffer.slice(0)) as Bytes;
  }

  /**
   * Send a frame and wait for the reply.
   *
   * Subscribes before writing, because a device that answers immediately would otherwise race the listener.
   * The first notification declares the total length; fragments accumulate until it is reached.
   */
  async request(frame: Bytes): Promise<Bytes> {
    if (!this.connected) throw new BleError("not connected");

    const reply = this.collect();
    await this.write(frame);
    return reply;
  }

  /**
   * Send a frame by a route other than the default, and report the reply.
   *
   * Two things this can establish that the ordinary path cannot:
   *
   * - **`withoutResponse` is an MTU probe.** Web Bluetooth rejects a write-without-response longer than
   *   the link's MTU less three, where the with-response path quietly falls back to an ATT long write. So
   *   a failure here puts a number on the MTU, and a success proves the frame fits in one packet — which
   *   would clear the MTU of suspicion entirely.
   * - **`0xFF04` is the vendor's other write target**, used by its `sendDataNoResepone`. Nothing yet shows
   *   what belongs there rather than on `0xFF01`.
   */
  async requestVia(frame: Bytes, route: Route): Promise<Bytes> {
    if (!this.connected) throw new BleError("not connected");

    let target = this.io;
    if (route.characteristic === "ff04") {
      const service = await this.device.gatt?.getPrimaryService(UUID.service);
      if (!service) throw new BleError("not connected");
      target = await service.getCharacteristic(UUID.ff04);
    }

    const reply = this.collect();
    if (route.withoutResponse) await target.writeValueWithoutResponse(frame);
    else await target.writeValueWithResponse(frame);
    return reply;
  }

  /**
   * Write a frame in a single call.
   *
   * **One write per frame, never split.** The vendor app passes `split = false` to its Bluetooth library,
   * and a version of this client that chunked to fit a 23-octet MTU got no reply at all — the device does
   * not reassemble. Web Bluetooth will use an ATT long write if the frame exceeds the negotiated MTU, and a
   * 26-octet read has been observed working, so the link settles well above the minimum in practice.
   */
  private async write(frame: Bytes): Promise<void> {
    await this.io.writeValueWithResponse(frame);
  }

  /** Accumulate notification fragments into one frame. */
  private collect(): Promise<Bytes> {
    return new Promise<Bytes>((resolve, reject) => {
      let buffer = new Uint8Array(0) as Bytes;

      const done = (outcome: () => void) => {
        clearTimeout(timer);
        this.io.removeEventListener("characteristicvaluechanged", onChange);
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

      const onChange = () => {
        const value = this.io.value;
        if (!value) return;

        const fragment = new Uint8Array(value.buffer.slice(0));
        const grown = new Uint8Array(buffer.length + fragment.length) as Bytes;
        grown.set(buffer, 0);
        grown.set(fragment, buffer.length);
        buffer = grown;

        // Not everything the device sends is a reply. Discard what cannot be a frame and keep waiting,
        // rather than assembling it into something that will fail to parse — the firmware's leftover
        // counter would otherwise be mistaken for an answer, and the real one arrive too late.
        if (looksLikeFrame(buffer) === false) {
          buffer = new Uint8Array(0) as Bytes;
          return;
        }

        const total = declaredLength(buffer);
        if (total !== null && buffer.length >= total) {
          const frame = buffer.subarray(0, total) as Bytes;
          done(() => resolve(frame));
        }
      };

      this.io.addEventListener("characteristicvaluechanged", onChange);
    });
  }
}
