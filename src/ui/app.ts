/**
 * What happens, and in what order.
 *
 * The controller: it owns the session, handles the events, and delegates everything about the document to
 * `view.ts` and everything about the device to `Device`. Nothing here knows about framing, ciphers or GATT.
 */

import { AuthenticationError, Device } from "../device.ts";
import {
  configure as configureCipher,
  isConfigured as isCipherConfigured,
  unconfigure as unconfigureCipher,
} from "../protocol/crypto.ts";
import {
  batches,
  describe,
  everyChoice,
  everyParam,
  numbersOf,
  PARAM_SPACE_LAST,
  PROVISIONING,
} from "../protocol/params.ts";
import { install } from "../pwa.ts";
import { forget, load, save } from "../settings.ts";
import { Connection, choose, isSupported } from "../transport/ble.ts";
import {
  appendResult,
  batchSize,
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
    refreshConnect();
  }
}

function onDisconnected(): void {
  connection = null;
  device = null;
  log("device disconnected");
  setStatus("disconnected");
  visibility.readout(false);
  refreshConnect();
}

/**
 * Offer to find a device only when there is something to say to one.
 *
 * Without all three constants the app cannot get past the handshake, and the failure it would produce —
 * a refused key, or a frame the device ignores in silence — says nothing about the actual cause. A button
 * that is not offered is clearer than an error that misdirects.
 */
function refreshConnect(): void {
  const missing = [dom.cipherKey, dom.cipherIv, dom.key].some((input) => input.value.trim() === "");
  const ready = !missing && isCipherConfigured();
  dom.connect.disabled = !ready;
  dom.connect.title = ready ? "" : "Enter the protocol constants first";
}

/**
 * Read a set of parameters, showing each as it arrives.
 *
 * The batch size comes from the control. Sizes up to 16 answer completely over this transport, including
 * across the connection-event records that make a reply large — about ninety octets each — so the reply
 * size a batch implies is not the constraint it looked like it might be.
 *
 * The run reports how many requests it sent regardless, because the failure mode of asking for too many is
 * quiet: a device that ignores the count answers part of each batch, which reads as a fast sweep that found
 * less rather than as an error.
 *
 * Results stream because the device answers slowly and out of order, and because a parameter that answers
 * nothing is an ordinary outcome rather than a fault: the run says so and carries on.
 */
async function readSet(params: readonly number[], what: string): Promise<void> {
  const session = device;
  if (!session) return;

  const batch = batchSize();
  const requests = batches(params, batch).length;
  appendResult(
    requests === params.length
      ? `reading ${what}…`
      : `reading ${what} — ${params.length} parameters in ${requests} requests of up to ${batch}…`,
  );
  await whileBusy([dom.read, dom.readProvisioning, dom.readSpace], async () => {
    let held = 0;
    let blank = 0;
    let absent = 0;
    let lost = 0;
    for await (const answer of session.sweep(batch, params)) {
      switch (answer.kind) {
        case "value":
          // An empty value is an answer, not a value: the parameter exists and holds nothing. Counting it
          // as content would report a fuller device than there is, and counting it as no answer would
          // hide the difference from a parameter that produced no entry at all — which is the `silent`
          // case below, and a different fact about the device.
          if (answer.value.length > 0) {
            held += 1;
          } else {
            blank += 1;
          }
          appendResult(`${describe(answer.param).padEnd(22)} ${renderValue(answer.value)}`);
          break;
        case "silent":
          absent += answer.params.length;
          for (const param of answer.params) {
            appendResult(`${describe(param).padEnd(22)} (no entry in the reply)`);
          }
          break;
        case "unanswered":
          lost += answer.params.length;
          log(`no answer for ${answer.params.join(", ")}: ${answer.reason}`);
          break;
      }
    }
    appendResult(
      `\n${held} held a value, ${blank} answered empty, ${absent} gave no entry, ${lost} went unanswered`,
    );
    log(`read ${params.length} parameters: ${held} values, ${blank} empty, ${absent} absent, ${lost} lost`);
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

/**
 * Load the supplied constants, keep them stored as they are edited, and hand the cipher its two.
 *
 * Opened automatically when anything is missing, because the app cannot do a single useful thing until all
 * three are present and a collapsed block gives no hint of that.
 */
function wireSecrets(): void {
  const stored = load();
  dom.cipherKey.value = stored.cipherKey;
  dom.cipherIv.value = stored.cipherIv;
  dom.key.value = stored.bindKey;

  const applyCipher = (): void => {
    try {
      configureCipher({ key: dom.cipherKey.value.trim(), iv: dom.cipherIv.value.trim() });
    } catch {
      // Half-typed is the normal state of an input being filled in, so this says nothing — but it must
      // still drop what was configured before. Otherwise editing a good value into a bad one would leave
      // the old pair in force behind a field that no longer shows it.
      unconfigureCipher();
    }
  };

  const remember = (field: "cipherKey" | "cipherIv" | "bindKey", input: HTMLInputElement): void => {
    input.addEventListener("input", () => {
      if (field !== "bindKey") applyCipher();
      refreshConnect();
    });
    input.addEventListener("change", () => save(field, input.value.trim()));
  };
  remember("cipherKey", dom.cipherKey);
  remember("cipherIv", dom.cipherIv);
  remember("bindKey", dom.key);

  dom.forget.addEventListener("click", (event) => {
    // It lives inside the <summary>, where any click toggles the disclosure. Clearing the fields should
    // not also close the block that shows them.
    event.preventDefault();
    event.stopPropagation();
    forget();
    for (const input of [dom.cipherKey, dom.cipherIv, dom.key]) input.value = "";
    dom.secrets.open = true;
    refreshConnect();
    log("the stored constants were forgotten");
  });

  applyCipher();
  refreshConnect();
  dom.secrets.open = !(stored.cipherKey && stored.cipherIv && stored.bindKey);
}

/** Bootstrap. Called once, from `main.ts`. */
export function start(): void {
  dom.build.textContent = `build ${BUILD} · read-only`;
  offlineAndUpdates();

  if (!isSupported()) {
    visibility.unsupported();
    return;
  }

  fillParameters(everyChoice());
  wireSecrets();
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
