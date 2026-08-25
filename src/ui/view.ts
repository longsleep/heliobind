/**
 * The document: element handles, and the functions that turn values into text.
 *
 * Everything here is about presentation. It holds no state and performs no I/O, so the controller in
 * `app.ts` is left with nothing but the sequence of events — which is the part worth reading.
 */

import { describe } from "../protocol/params.ts";
import { accepted, type Response } from "../protocol/response.ts";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found as T;
}

/** Every element the page interacts with, resolved once so a renamed id fails loudly at startup. */
export const dom = {
  unsupported: el("unsupported"),
  app: el("app"),
  key: el<HTMLInputElement>("key"),
  connect: el<HTMLButtonElement>("connect"),
  device: el("device"),
  deviceName: el("device-name"),
  deviceStatus: el("device-status"),
  deviceSerial: el("device-serial"),
  readout: el("readout"),
  param: el<HTMLSelectElement>("param"),
  read: el<HTMLButtonElement>("read"),
  readAll: el<HTMLButtonElement>("read-all"),
  info: el<HTMLButtonElement>("info"),
  result: el<HTMLPreElement>("result"),
  log: el<HTMLPreElement>("log"),
  build: el("build"),
} as const;

const NOTHING_LOGGED = "nothing yet";

export function setStatus(text: string): void {
  dom.deviceStatus.textContent = text;
}

export function setResult(text: string): void {
  dom.result.textContent = text;
}

/**
 * Append to the running record, timestamped.
 *
 * Never cleared, and the element sits outside the block hidden on disconnect — the log is most valuable at
 * exactly the moment the device goes away.
 */
export function log(text: string): void {
  const at = new Date().toISOString().slice(11, 23);
  const previous = dom.log.textContent;
  dom.log.textContent = previous === NOTHING_LOGGED ? `${at}  ${text}` : `${previous}\n${at}  ${text}`;
}

/** What went wrong, in one line, without assuming an Error was thrown. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** A response as a table of parameter, name and value. */
export function renderResponse(response: Response): string {
  if (response.values.length === 0) {
    return accepted(response) ? "accepted, no values returned" : `refused, status ${response.status}`;
  }
  return response.values
    .map(({ param, value }) => `${String(param).padStart(3)}  ${describe(param).padEnd(16)}  ${value}`)
    .join("\n");
}

/** Offer every known parameter, with its summary as a tooltip. */
export function fillParameters(params: readonly { number: number; name: string; summary: string }[]): void {
  for (const param of params) {
    const option = document.createElement("option");
    option.value = String(param.number);
    option.textContent = `${param.number} — ${param.name}`;
    option.title = param.summary;
    dom.param.append(option);
  }
}

/** Show or hide the whole interface, and the parts that depend on a live device. */
export const visibility = {
  unsupported(): void {
    dom.unsupported.hidden = false;
  },
  ready(): void {
    dom.app.hidden = false;
  },
  device(shown: boolean): void {
    dom.device.hidden = !shown;
  },
  readout(shown: boolean): void {
    dom.readout.hidden = !shown;
  },
};

/** Disable a set of buttons for the duration of a request, then restore them. */
export async function whileBusy<T>(
  buttons: readonly HTMLButtonElement[],
  work: () => Promise<T>,
): Promise<T> {
  for (const button of buttons) button.disabled = true;
  try {
    return await work();
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}
