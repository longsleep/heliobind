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
  GROUPS,
  type Group,
  LINK_STATUS,
  numbersOf,
  PARAM_SPACE_LAST,
  type Param,
  PROVISIONING,
  RESTART,
  WRITABLE,
} from "../protocol/params.ts";
import { accepted } from "../protocol/response.ts";
import { install, offerInstall } from "../pwa.ts";
import { forget, load, mayOfferInstall, refuseInstall, save } from "../settings.ts";
import { Connection, choose, isSupported } from "../transport/ble.ts";
import {
  appendResult,
  batchSize,
  clearLog,
  clearResult,
  describeError,
  dom,
  fillParameters,
  fillWritable,
  groupField,
  groupReadable,
  log,
  renderGroups,
  renderReading,
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
          appendResult(`${describe(answer.param).padEnd(22)} ${renderReading(answer.param, answer.value)}`);
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

/**
 * Write one setting and read it straight back.
 *
 * The read-back is not a nicety. A write is acknowledged with a status and no values, so an accepted write
 * tells you the device understood the frame — not that it stored what you meant, and not that the value
 * survives whatever the firmware does to it. Only a read afterwards distinguishes those, so the button
 * always does both and reports both.
 */
async function writeSetting(): Promise<void> {
  const session = device;
  if (!session) return;

  const param = Number(dom.writeParam.value);
  const value = dom.writeValue.value;
  if (!Number.isFinite(param)) return;

  const before = dom.writeValue.value.trim() === "" ? "an empty value" : `"${value}"`;
  appendResult(`writing ${describe(param)} = ${before}…`);

  await whileBusy([dom.write], async () => {
    try {
      const answer = await session.write([{ param, value }]);
      appendResult(
        accepted(answer)
          ? `${describe(param).padEnd(22)} write accepted`
          : `${describe(param).padEnd(22)} write refused, status ${answer.status}`,
      );
      log(`wrote ${param}: status ${answer.status}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendResult(`${describe(param).padEnd(22)} write failed: ${reason}`);
      log(`write of ${param} failed: ${reason}`);
      return;
    }

    // Whatever the device now holds, which is the only answer worth having.
    try {
      const back = await session.read([param]);
      const held = back.values.find((entry) => entry.param === param);
      appendResult(
        held
          ? `${describe(param).padEnd(22)} now ${renderReading(param, held.value)}`
          : `${describe(param).padEnd(22)} read back gave no entry`,
      );
    } catch (error) {
      appendResult(`${describe(param).padEnd(22)} could not be read back: ${reasonOf(error)}`);
    }
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What each group held when it was last read.
 *
 * A write sends only the parameters that differ from this, which is what the vendor's own client does. The
 * reason is not economy: a frame that re-asserts every field also re-asserts the ones somebody else changed
 * in between, and the device cannot tell the difference between "set this again" and "set this back".
 */
const held = new Map<string, Map<number, string>>();

/** Read one group and fill its fields. */
async function readGroup(group: Group): Promise<void> {
  const session = device;
  if (!session) return;

  appendResult(`reading ${group.title}…`);
  await whileBusy([dom.restart, dom.linkStatus], async () => {
    try {
      // One request for the whole group, in the order the device expects them back.
      const answer = await session.read(group.params.map((param) => param.number));
      const values = new Map(answer.values.map((value) => [value.param, value.value]));
      held.set(group.key, values);
      for (const param of group.params) {
        const field = groupField(group, param);
        // A parameter the device did not answer for is left empty rather than filled with a guess, and an
        // empty field written back is an empty value — which is a legitimate setting here, not a mistake.
        if (field) field.value = values.get(param.number) ?? "";
        appendResult(
          `${describe(param.number).padEnd(22)} ${renderReading(param.number, values.get(param.number) ?? "")}`,
        );
      }
      groupReadable(group, true);
    } catch (error) {
      appendResult(`${group.title}: could not be read: ${reasonOf(error)}`);
    }
  });
}

/** Write what changed in one group, as one frame, then read it back. */
async function writeGroup(group: Group): Promise<void> {
  const session = device;
  if (!session) return;

  const before = held.get(group.key);
  if (!before) {
    appendResult(`${group.title}: read it first — a write sends only what differs`);
    return;
  }

  const edits = group.params
    .map((param) => ({ param, field: groupField(group, param) }))
    .filter((entry): entry is { param: Param; field: HTMLInputElement } => entry.field !== null)
    .filter((entry) => entry.field.value !== (before.get(entry.param.number) ?? ""))
    .map((entry) => ({ param: entry.param.number, value: entry.field.value }));

  if (edits.length === 0) {
    appendResult(`${group.title}: nothing changed, so nothing sent`);
    return;
  }

  // Named in full, because this is the last point at which a person can stop it and the device has no
  // undo. The list is what will actually go out, not what the form holds.
  const summary = edits
    .map((edit) => `${describe(edit.param)} = ${edit.value === "" ? "(empty)" : edit.value}`)
    .join("\n");
  if (group.disruptive && !confirm(`Write ${group.title}?\n\n${summary}\n\nBluetooth is the way back.`)) {
    appendResult(`${group.title}: not written`);
    return;
  }

  await whileBusy([dom.restart, dom.linkStatus], async () => {
    try {
      const answer = await session.write(edits);
      appendResult(
        accepted(answer)
          ? `${group.title}: ${edits.length} parameter(s) accepted`
          : `${group.title}: refused, status ${answer.status}`,
      );
      log(`wrote ${group.key}: ${edits.map((edit) => edit.param).join(", ")}, status ${answer.status}`);
    } catch (error) {
      appendResult(`${group.title}: write failed: ${reasonOf(error)}`);
      return;
    }
  });
  // Whatever it now holds, which is the only answer worth having — and it refreshes the baseline, so a
  // second write sends only what changed since this read.
  await readGroup(group);
  appendResult(`${group.title}: restart the datalogger for it to take effect`);
}

/** Restart the datalogger, which is how a staged change is committed. */
async function restartDatalogger(): Promise<void> {
  const session = device;
  if (!session) return;
  if (
    !confirm("Restart the datalogger?\n\nIt reboots and reconnects by itself; telemetry pauses meanwhile.")
  ) {
    return;
  }
  await whileBusy([dom.restart], async () => {
    try {
      const answer = await session.write([{ param: RESTART.number, value: "1" }]);
      appendResult(accepted(answer) ? "restart accepted" : `restart refused, status ${answer.status}`);
    } catch (error) {
      appendResult(`restart failed: ${reasonOf(error)}`);
    }
  });
}

/**
 * Ask the device about its own two links.
 *
 * The only confirmation a change worked, short of the device turning up somewhere else: the router status
 * says whether it joined, the server status whether it reported in. Both take a while after a restart, so
 * an unexpected value shortly afterwards means "not yet" rather than "failed".
 */
async function checkLinks(): Promise<void> {
  const session = device;
  if (!session) return;
  await whileBusy([dom.linkStatus], async () => {
    try {
      const answer = await session.read(LINK_STATUS.map((param) => param.number));
      for (const param of LINK_STATUS) {
        const value = answer.values.find((entry) => entry.param === param.number);
        appendResult(
          `${describe(param.number).padEnd(22)} ${value ? renderReading(param.number, value.value) : "(no answer)"}`,
        );
      }
    } catch (error) {
      appendResult(`could not read the link status: ${reasonOf(error)}`);
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
 * Offer to install, once the browser reports that it can.
 *
 * Whether to *show* the offer is decided here rather than in `pwa.ts`: that module knows about the browser
 * and deliberately nothing about how often it is polite to ask. Both refusals — the bar's own Not now and a
 * dismissal of the browser's dialog — are recorded the same way, so either silences it for a month.
 */
function installOffer(): void {
  offerInstall({
    show: () => {
      if (mayOfferInstall(Date.now())) dom.offer.hidden = false;
    },
    hide: () => {
      dom.offer.hidden = true;
    },
    onAccept: (take) => dom.install.addEventListener("click", take),
    declined: () => refuseInstall(Date.now()),
  });

  dom.installLater.addEventListener("click", () => {
    refuseInstall(Date.now());
    dom.offer.hidden = true;
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
  dom.build.textContent = `build ${BUILD}`;
  offlineAndUpdates();

  if (!isSupported()) {
    visibility.unsupported();
    return;
  }

  // After the check above, deliberately: a browser that cannot reach a device over Bluetooth should not be
  // offered an app it cannot use. Still synchronous, which is what the offer requires.
  installOffer();

  fillParameters(everyChoice());
  fillWritable(WRITABLE);
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
  dom.write.addEventListener("click", () => void writeSetting());
  dom.restart.addEventListener("click", () => void restartDatalogger());
  dom.linkStatus.addEventListener("click", () => void checkLinks());
  renderGroups(GROUPS, { read: (group) => void readGroup(group), write: (group) => void writeGroup(group) });
}
