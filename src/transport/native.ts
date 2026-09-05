/**
 * Android transport, over the Capacitor Bluetooth plugin.
 *
 * The build reaches this through `#transport` under the `capacitor` condition, so it exists only in the
 * package — the web bundle never imports it, and nothing here is published to npm.
 *
 * It answers the same {@link Link} contract as `web.ts` and differs in three ways that are the plugin's,
 * not this project's:
 *
 * - **A device is a string.** `deviceId` is the MAC on Android, and it persists, where a browser hands back
 *   an object that is only good for the session. Reconnecting without a fresh chooser becomes possible for
 *   the first time, which is what a restart of the datalogger needs.
 * - **Notifications arrive by callback**, one per characteristic, rather than as an event on an object. One
 *   subscription is made at connect time and fanned out here, because subscribing twice to the same
 *   characteristic is not something the plugin promises to handle.
 * - **Values are `DataView`.** Frames are `Uint8Array`, so each crossing converts.
 */

import { BleClient, type BleDevice, numbersToDataView } from "@capacitor-community/bluetooth-le";
import type { Bytes } from "../protocol/frame.ts";
import { assemble, BleError, type Link, type Route, SERVICE, UUID, VENDOR } from "./link.ts";

export type { Link, Route } from "./link.ts";
export { BleError, SERVICE, UUID, VENDOR } from "./link.ts";

/** A device somebody picked. Android hands back an identifier — the MAC — rather than an object. */
export type Chosen = BleDevice;

/** Which half of the build this is, for the few places that must not offer a browser's furniture natively. */
export const NATIVE = true;

/**
 * Whether this build can do any of this at all.
 *
 * True by construction: the plugin is compiled into the package, and a device without Bluetooth is a
 * runtime failure at {@link choose} rather than something to hide the interface for.
 */
export function isSupported(): boolean {
  return true;
}

/**
 * Ask the user to choose a device, then open it.
 *
 * The filter is the same pair the browser is given — the service to reach the characteristics, the
 * manufacturer-data marker to make the offer specific — but Android insists a manufacturer filter carry a
 * `dataPrefix`. What follows the company identifier is the device-type code, which differs across the
 * family, so the prefix is one byte under a **zero mask**: a byte that must match nothing. That satisfies
 * the platform without narrowing the filter to a single model.
 */
export async function choose(): Promise<Chosen> {
  // No `androidNeverForLocation`: asserting it requires a manifest that declares BLUETOOTH_SCAN with the
  // matching flag, and the plugin's does not. Asserted without it, the app never asks for location
  // permission while Android still treats scanning as location-derived — and a scan then returns nothing
  // at all, silently, which looks exactly like a device that is not there.
  await BleClient.initialize();
  return BleClient.requestDevice({
    // Both, and they are an *or* rather than an and: the plugin turns each entry into its own Android
    // ScanFilter, and Android matches a device that satisfies any of them. That is the opposite of the
    // browser, where the two conditions in one filter must both hold, so this list is wider than the web
    // chooser's on purpose — hardware that shares Espressif's example UUID can appear alongside the real
    // device. It is the cost of the marker filter not being reliable on Android, and being able to
    // connect at all is worth a longer list.
    services: [UUID.service],
    manufacturerData: [
      {
        companyIdentifier: VENDOR,
        dataPrefix: new Uint8Array([0]),
        mask: new Uint8Array([0]),
      },
    ],
  });
}

/** Open what was chosen. Separate from choosing so that what the chooser asks for can be tested alone. */
export function open(chosen: Chosen): Promise<Link> {
  return NativeLink.open(chosen.deviceId, chosen.name ?? "(unnamed)");
}

/** An open connection to one device, over the Android Bluetooth stack. */
export class NativeLink implements Link {
  onNotification: ((data: Bytes) => void) | null = null;
  onDisconnected: (() => void) | null = null;

  /** Everything waiting on a fragment. One plugin subscription feeds them all. */
  private readonly listeners = new Set<(data: Bytes) => void>();
  private open = true;

  /** Filled in at connect time; see {@link Link.describe}. */
  describe = "Android";

  private constructor(
    private readonly deviceId: string,
    readonly name: string,
  ) {}

  static async open(deviceId: string, name: string): Promise<Link> {
    const link = new NativeLink(deviceId, name);
    await BleClient.connect(deviceId, () => {
      link.open = false;
      link.onDisconnected?.();
    });
    await BleClient.startNotifications(deviceId, UUID.service, UUID.io, (value) => {
      const data = new Uint8Array(value.buffer.slice(0)) as Bytes;
      link.onNotification?.(data);
      for (const listener of link.listeners) listener(data);
    });

    // The number that decides whether a frame survives the trip. Android starts at 23 octets and the
    // plugin asks for 512; what the device grants is what matters, and a frame longer than MTU less three
    // is truncated rather than refused — which looks exactly like a device that did not answer.
    try {
      link.describe = `Android, MTU ${await BleClient.getMtu(deviceId)}`;
    } catch {
      link.describe = "Android, MTU unknown";
    }
    return link;
  }

  get connected(): boolean {
    return this.open;
  }

  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await BleClient.disconnect(this.deviceId);
  }

  async readInfo(): Promise<Bytes> {
    if (!this.open) throw new BleError("not connected");
    const value = await BleClient.read(this.deviceId, UUID.service, UUID.info);
    return new Uint8Array(value.buffer.slice(0)) as Bytes;
  }

  async request(frame: Bytes): Promise<Bytes> {
    return this.send(frame, { characteristic: "io", withoutResponse: false });
  }

  async requestVia(frame: Bytes, route: Route): Promise<Bytes> {
    return this.send(frame, route);
  }

  /**
   * Write a frame and wait for the reply.
   *
   * Subscribed before writing, because a device that answers immediately would otherwise race the listener.
   *
   * **One write per frame, never split.** The device does not reassemble, and a client that chunked to a
   * 23-octet MTU got no reply at all. Whether the plugin splits a frame larger than the negotiated MTU is
   * the open question of this port: if it does, a long read will time out rather than fail loudly.
   */
  private async send(frame: Bytes, route: Route): Promise<Bytes> {
    if (!this.open) throw new BleError("not connected");

    const characteristic = route.characteristic === "ff04" ? UUID.ff04 : UUID.io;
    const reply = assemble((fragment) => {
      this.listeners.add(fragment);
      return () => this.listeners.delete(fragment);
    });

    const value = numbersToDataView(Array.from(frame));
    if (route.withoutResponse) {
      await BleClient.writeWithoutResponse(this.deviceId, UUID.service, characteristic, value);
    } else {
      await BleClient.write(this.deviceId, UUID.service, characteristic, value);
    }
    return reply;
  }
}

// `SERVICE` is the 16-bit form the browser accepts and the plugin does not; it is re-exported for the
// interface's sake and deliberately unused here, where every call takes the long UUID.
void SERVICE;
