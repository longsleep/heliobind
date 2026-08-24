/**
 * Web Bluetooth transport.
 *
 * Everything specific to the browser's Bluetooth API lives here. The protocol modules are pure functions
 * over bytes and must not import this file — that separation is what makes them testable without a device.
 *
 * Two facts shape the design:
 *
 * - **MTU is not exposed.** Web Bluetooth negotiates it and does not say what it got, and reports of what
 *   Chrome on Android settles on are inconsistent. Writes are therefore split to a conservative size and the
 *   device reassembles, which is what its length-prefixed framing is for.
 * - **Replies arrive in pieces.** Notifications carry fragments; the first two octets of the first fragment
 *   declare the total. {@link Connection.request} accumulates until that total is satisfied.
 */

import { type Bytes, declaredLength } from "../protocol/frame.ts";

/** Vendor service. Filtering on it identifies this family of device rather than one unit. */
export const SERVICE = 0x00ff;

/** Request and response share one characteristic: write here, and the answer arrives as a notification. */
export const CHARACTERISTIC_IO = 0x0ff1_0000;

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
} as const;

/**
 * Octets per write.
 *
 * Chosen to fit the smallest MTU a link may end up with — 23 octets, leaving 20 for payload — because the
 * API gives no way to discover the real value. Larger writes may work and would be faster; they may also be
 * silently truncated, which is worse than slow.
 */
const CHUNK = 20;

/** How long to wait for a reply before giving up. */
const REPLY_TIMEOUT_MS = 5_000;

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
 */
export async function choose(): Promise<BluetoothDevice> {
  if (!isSupported()) throw new BleError("this browser does not support Web Bluetooth");
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE] }],
    optionalServices: [SERVICE],
  });
}

/** An open connection to one device. */
export class Connection {
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
    await io.startNotifications();
    return new Connection(device, io);
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

  /** Write a frame, split into chunks the smallest plausible MTU can carry. */
  private async write(frame: Bytes): Promise<void> {
    for (let at = 0; at < frame.length; at += CHUNK) {
      const chunk = frame.subarray(at, Math.min(at + CHUNK, frame.length));
      // writeValueWithoutResponse would be faster but gives no backpressure, and a dropped fragment
      // leaves the device waiting on a length it will never reach.
      await this.io.writeValueWithResponse(chunk);
    }
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
