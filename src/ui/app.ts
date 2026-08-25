/**
 * What happens, and in what order.
 *
 * The controller: it owns the session, handles the events, and delegates everything about the document to
 * `view.ts` and everything about the device to `Device`. Nothing here knows about framing, ciphers or GATT.
 */

import { AuthenticationError, Device } from "../device.ts";
import { PARAMS } from "../protocol/params.ts";
import { Connection, choose, isSupported } from "../transport/ble.ts";
import {
  describeError,
  dom,
  fillParameters,
  log,
  renderResponse,
  setResult,
  setStatus,
  visibility,
  whileBusy,
} from "./view.ts";

/**
 * The key compiled into the vendor app, offered as the default.
 *
 * Identical on every device and accepted by the one this was developed against, so it is a starting value
 * rather than a secret. The field stays editable because another device may hold something else — whatever
 * parameter 54 contains, which is readable over the network interface as well as this one.
 */
const COMMON_KEY = "redacted_see_readme_not_shipped_";

/** Set at build time; see the build script. `typeof` on an undeclared name is safe in JavaScript. */
declare const __BUILD_REF__: string;
const BUILD: string = typeof __BUILD_REF__ === "undefined" ? "development" : __BUILD_REF__;

let connection: Connection | null = null;
let device: Device | null = null;

/**
 * Choose a device, connect, and authenticate.
 *
 * The handshake is part of connecting rather than a separate step, because a session without it is not
 * usable: the device discards everything else in silence.
 */
async function connect(): Promise<void> {
  dom.connect.disabled = true;
  try {
    const chosen = await choose();
    visibility.device(true);
    dom.deviceName.textContent = chosen.name ?? "(unnamed)";
    setStatus("connecting");

    chosen.addEventListener("gattserverdisconnected", onDisconnected);

    connection = await Connection.open(chosen);
    connection.onNotification = (data) => log(`notify ${data.length} octets`);
    log("connected");

    setStatus("authenticating");
    device = await Device.open(connection, dom.key.value.trim());
    dom.deviceSerial.textContent = device.serial;
    setStatus("ready");
    log(`authenticated; the device reports serial ${device.serial}`);
    visibility.readout(true);
    setResult("Authenticated. Reads should now be answered.");
  } catch (error) {
    // Worth distinguishing: a refusal means the frame was understood and only the key was wrong.
    setStatus(error instanceof AuthenticationError ? "key refused" : "not connected");
    setResult(describeError(error));
    log(describeError(error));
    dom.connect.disabled = false;
  }
}

function onDisconnected(): void {
  connection = null;
  device = null;
  log("device disconnected");
  setStatus("disconnected");
  visibility.readout(false);
  dom.connect.disabled = false;
}

async function readParams(params: readonly number[]): Promise<void> {
  const session = device;
  if (!session) return;

  setResult(`reading ${params.length} parameter${params.length === 1 ? "" : "s"}…`);
  await whileBusy([dom.read, dom.readAll], async () => {
    try {
      setResult(renderResponse(await session.read(params)));
    } catch (error) {
      setResult(describeError(error));
      log(`read failed: ${describeError(error)}`);
    }
  });
}

/** Read the informational characteristic: no framing, no cipher, no checksum. A transport check. */
async function readInfo(): Promise<void> {
  const link = connection;
  if (!link) return;

  await whileBusy([dom.info], async () => {
    try {
      const value = await link.readInfo();
      setResult(`0xFF02 returned ${value.length} octets: ${new TextDecoder().decode(value)}`);
    } catch (error) {
      setResult(describeError(error));
    }
  });
}

/** Bootstrap. Called once, from `main.ts`. */
export function start(): void {
  dom.build.textContent = `build ${BUILD} · read-only`;

  if (!isSupported()) {
    visibility.unsupported();
    return;
  }

  fillParameters(PARAMS);
  dom.key.value = COMMON_KEY;
  visibility.ready();

  dom.connect.addEventListener("click", () => void connect());
  dom.read.addEventListener("click", () => void readParams([Number(dom.param.value)]));
  dom.readAll.addEventListener("click", () => void readParams(PARAMS.map((param) => param.number)));
  dom.info.addEventListener("click", () => void readInfo());
}
