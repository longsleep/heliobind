/**
 * Web Bluetooth transport.
 *
 * Everything specific to the browser's Bluetooth API lives here, and the build reaches it through
 * `#transport` — so a bundle made for the browser contains this file and never the Android one.
 *
 * One fact shapes the design beyond what {@link Link} already states: **MTU is not exposed.** Web Bluetooth
 * negotiates it and does not say what it got. Frames are written whole regardless, because the device does
 * not reassemble split writes — see {@link WebLink.write}.
 */

import type { Bytes } from "../protocol/frame.ts";
import { assemble, BleError, type Link, type Route, SERVICE, UUID, VENDOR } from "./link.ts";

export type { Link, Route } from "./link.ts";
export { BleError, SERVICE, UUID, VENDOR } from "./link.ts";

/** A device somebody picked. The browser hands back an object; Android hands back an identifier. */
export type Chosen = BluetoothDevice;

/** Which half of the build this is, for the few places that must not offer a browser's furniture natively. */
export const NATIVE = false;

/** Whether this browser can do any of this at all. */
export function isSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/**
 * Ask the user to choose a device, then open it.
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
export async function choose(): Promise<Chosen> {
  if (!isSupported()) throw new BleError("this browser does not support Web Bluetooth");
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE], manufacturerData: [{ companyIdentifier: VENDOR }] }],
    optionalServices: [SERVICE],
  });
}

/** Open what was chosen. Separate from choosing so that what the chooser asks for can be tested alone. */
export function open(chosen: Chosen): Promise<Link> {
  return WebLink.open(chosen);
}

/** An open connection to one device, over the browser's Bluetooth stack. */
export class WebLink implements Link {
  onNotification: ((data: Bytes) => void) | null = null;
  onDisconnected: (() => void) | null = null;

  private constructor(
    private readonly device: BluetoothDevice,
    private readonly io: BluetoothRemoteGATTCharacteristic,
  ) {}

  static async open(device: BluetoothDevice): Promise<Link> {
    const gatt = device.gatt;
    if (!gatt) throw new BleError("device exposes no GATT server");

    const server = await gatt.connect();
    const service = await server.getPrimaryService(UUID.service);
    const io = await service.getCharacteristic(UUID.io);

    const link = new WebLink(device, io);
    io.addEventListener("characteristicvaluechanged", () => {
      const value = io.value;
      if (value) link.onNotification?.(new Uint8Array(value.buffer.slice(0)) as Bytes);
    });
    device.addEventListener("gattserverdisconnected", () => link.onDisconnected?.());
    await io.startNotifications();
    return link;
  }

  get name(): string {
    return this.device.name ?? "(unnamed)";
  }

  /** Web Bluetooth does not expose the MTU it negotiated, so there is nothing to report but the transport. */
  readonly describe = "Web Bluetooth";

  get connected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  async close(): Promise<void> {
    if (this.connected) this.device.gatt?.disconnect();
  }

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
   *   a failure here puts a number on the MTU, and a success proves the frame fits in one packet.
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

  /** Accumulate notification fragments into one frame, listening on the characteristic's own event. */
  private collect(): Promise<Bytes> {
    return assemble((fragment) => {
      const onChange = () => {
        const value = this.io.value;
        if (value) fragment(new Uint8Array(value.buffer.slice(0)) as Bytes);
      };
      this.io.addEventListener("characteristicvaluechanged", onChange);
      return () => this.io.removeEventListener("characteristicvaluechanged", onChange);
    });
  }
}
