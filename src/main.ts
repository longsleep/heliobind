/**
 * Entry point: wires the DOM to the transport.
 *
 * The only file that touches the document. Protocol logic lives in `protocol/` and is pure; Bluetooth
 * lives in `transport/`. Keeping the three apart is what lets the protocol be tested without a device.
 */

import { decryptBody, encryptBody } from "./protocol/crypto.ts";
import { build, FUNCTION, fromAscii, parse, readConfigBody, toHex } from "./protocol/frame.ts";
import { describe, PARAMS } from "./protocol/params.ts";
import { Connection, choose, isSupported } from "./transport/ble.ts";

/**
 * Set at build time so a running page can be matched to a commit.
 *
 * Replaced by `--define` in the build script. `typeof` on an undeclared name is safe in JavaScript, so
 * the dev server needs no substitution.
 */
declare const __BUILD_REF__: string;
const BUILD: string = typeof __BUILD_REF__ === "undefined" ? "development" : __BUILD_REF__;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found as T;
}

const ui = {
  unsupported: el("unsupported"),
  app: el("app"),
  connect: el<HTMLButtonElement>("connect"),
  device: el("device"),
  deviceName: el("device-name"),
  deviceStatus: el("device-status"),
  readout: el("readout"),
  param: el<HTMLSelectElement>("param"),
  read: el<HTMLButtonElement>("read"),
  result: el<HTMLPreElement>("result"),
  build: el("build"),
};

let connection: Connection | null = null;

function status(text: string): void {
  ui.deviceStatus.textContent = text;
}

function show(text: string): void {
  ui.result.textContent = text;
}

/** Read one configuration parameter and render the reply. */
async function readParam(param: number): Promise<void> {
  if (!connection) throw new Error("not connected");

  const body = readConfigBody([param]);
  const frame = build(FUNCTION.readConfig, await encryptBody(body), body.length);

  const reply = await connection.request(frame);
  const parsed = parse(reply);
  const plain = (await decryptBody(parsed.body)).subarray(0, parsed.plaintextLen);

  // Rendered as both hex and ASCII deliberately. Nothing yet establishes how a reply body is laid
  // out, so showing the raw octets is more useful than a guess at their structure.
  show(
    [
      `function 0x${parsed.function.toString(16)}  protocol ${parsed.protocol}`,
      `plaintext ${parsed.plaintextLen} octets`,
      "",
      toHex(plain),
      "",
      JSON.stringify(fromAscii(plain)),
    ].join("\n"),
  );
}

function populateParams(): void {
  for (const param of PARAMS) {
    const option = document.createElement("option");
    option.value = String(param.number);
    option.textContent = `${param.number} — ${param.name}`;
    option.title = param.summary;
    ui.param.append(option);
  }
}

async function onConnect(): Promise<void> {
  ui.connect.disabled = true;
  try {
    const device = await choose();
    ui.device.hidden = false;
    ui.deviceName.textContent = device.name ?? "(unnamed)";
    status("connecting");

    device.addEventListener("gattserverdisconnected", () => {
      connection = null;
      status("disconnected");
      ui.readout.hidden = true;
      ui.connect.disabled = false;
    });

    connection = await Connection.open(device);
    status("connected");
    ui.readout.hidden = false;
  } catch (error) {
    // A user who dismisses the chooser is not an error worth shouting about.
    status(error instanceof Error ? error.message : "could not connect");
    ui.connect.disabled = false;
  }
}

async function onRead(): Promise<void> {
  const param = Number(ui.param.value);
  ui.read.disabled = true;
  show(`reading ${describe(param)}…`);
  try {
    await readParam(param);
  } catch (error) {
    show(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    ui.read.disabled = false;
  }
}

function main(): void {
  ui.build.textContent = `build ${BUILD} · read-only`;

  if (!isSupported()) {
    ui.unsupported.hidden = false;
    return;
  }

  populateParams();
  ui.app.hidden = false;
  ui.connect.addEventListener("click", () => void onConnect());
  ui.read.addEventListener("click", () => void onRead());
}

main();
