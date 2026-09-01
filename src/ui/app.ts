/**
 * What happens, and in what order.
 *
 * The controller: it owns the session, handles the events, and delegates everything about the document to
 * `view.ts` and everything about the device to `Device`. Nothing here knows about framing, ciphers or GATT.
 */

import { AuthenticationError, Device } from "../device.ts";
import {
  describe,
  everyParam,
  numbersOf,
  PARAM_SPACE_LAST,
  PARAMS,
  PROVISIONING,
} from "../protocol/params.ts";
import { install } from "../pwa.ts";
import { Connection, choose, isSupported } from "../transport/ble.ts";
import {
  appendResult,
  clearLog,
  clearResult,
  describeError,
  dom,
  fillParameters,
  log,
  renderValue,
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
    appendResult("Authenticated. Reads should now be answered.");
  } catch (error) {
    // Worth distinguishing: a refusal means the frame was understood and only the key was wrong.
    setStatus(error instanceof AuthenticationError ? "key refused" : "not connected");
    appendResult(describeError(error));
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

/**
 * Read a set of parameters, showing each as it arrives.
 *
 * One request per parameter. Not timidity: asking for many in one exchange makes the *reply* large — a
 * single connection-event record is about ninety octets — and a reply that does not fit is lost whole,
 * where a sequence of small ones is merely slow. {@link Device.sweep} takes the batch size, so raising it
 * is a one-word change once a larger count has been shown to work over this transport.
 *
 * Results stream because the device answers slowly and out of order, and because a parameter that answers
 * nothing is an ordinary outcome rather than a fault: the run says so and carries on.
 */
async function readSet(params: readonly number[], what: string): Promise<void> {
  const session = device;
  if (!session) return;

  appendResult(`reading ${what}…`);
  await whileBusy([dom.read, dom.readProvisioning, dom.readSpace], async () => {
    let held = 0;
    let empty = 0;
    let lost = 0;
    for await (const answer of session.sweep(1, params)) {
      switch (answer.kind) {
        case "value":
          // An empty value is an answer, not a value. Bluetooth returns a TLV for every parameter asked
          // for, including the ones holding nothing, where the network path returns no TLV at all — so
          // counting a present-but-empty entry as content would report a fuller device than there is.
          if (answer.value.length > 0) {
            held += 1;
          } else {
            empty += 1;
          }
          appendResult(`${describe(answer.param).padEnd(22)} ${renderValue(answer.value)}`);
          break;
        case "silent":
          empty += answer.params.length;
          break;
        case "unanswered":
          lost += answer.params.length;
          log(`no answer for ${answer.params.join(", ")}: ${answer.reason}`);
          break;
      }
    }
    appendResult(`\n${held} held a value, ${empty} answered nothing, ${lost} went unanswered`);
    log(`read ${params.length} parameters: ${held} values, ${empty} empty, ${lost} lost`);
  });
}

/** Read the informational characteristic: no framing, no cipher, no checksum. A transport check. */
async function readInfo(): Promise<void> {
  const link = connection;
  if (!link) return;

  await whileBusy([dom.info], async () => {
    try {
      const value = await link.readInfo();
      appendResult(`0xFF02 returned ${value.length} octets: ${new TextDecoder().decode(value)}`);
    } catch (error) {
      appendResult(describeError(error));
    }
  });
}

/**
 * Make the app installable and keep it current.
 *
 * Runs whether or not Bluetooth is available, and before the support check returns: a browser that cannot
 * talk to a device can still hold an installed copy, and an update that fixes the support problem should
 * still be able to arrive.
 */
function offlineAndUpdates(): void {
  void install({
    show: () => {
      dom.update.hidden = false;
      log("a newer version is ready; press Update to switch to it");
    },
    onAccept: (take) => dom.updateNow.addEventListener("click", take),
  }).then((problem) => {
    // Deliberately dropped rather than reported. The development server serves no worker, so this is the
    // ordinary case there; and where it is a real failure the reader can do nothing about it, while the app
    // itself works exactly as before — only without a cached copy. The log beside it is for device traffic.
    void problem;
  });
}

/** Bootstrap. Called once, from `main.ts`. */
export function start(): void {
  dom.build.textContent = `build ${BUILD} · read-only`;
  offlineAndUpdates();

  if (!isSupported()) {
    visibility.unsupported();
    return;
  }

  fillParameters(PARAMS);
  dom.key.value = COMMON_KEY;
  visibility.ready();

  dom.connect.addEventListener("click", () => void connect());
  dom.read.addEventListener("click", () => {
    const param = Number(dom.param.value);
    void readSet([param], describe(param));
  });
  dom.readProvisioning.addEventListener(
    "click",
    () => void readSet(numbersOf(PROVISIONING), "the provisioning settings"),
  );
  dom.readSpace.addEventListener(
    "click",
    () => void readSet(everyParam(), `parameters 0 to ${PARAM_SPACE_LAST}`),
  );
  dom.clearResult.addEventListener("click", clearResult);
  dom.clearLog.addEventListener("click", clearLog);
  dom.info.addEventListener("click", () => void readInfo());
}
