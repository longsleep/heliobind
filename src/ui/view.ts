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
  readProvisioning: el<HTMLButtonElement>("read-provisioning"),
  readSpace: el<HTMLButtonElement>("read-space"),
  info: el<HTMLButtonElement>("info"),
  clearResult: el<HTMLButtonElement>("clear-result"),
  clearLog: el<HTMLButtonElement>("clear-log"),
  result: el<HTMLPreElement>("result"),
  log: el<HTMLPreElement>("log"),
  update: el("update"),
  updateNow: el<HTMLButtonElement>("update-now"),
  build: el("build"),
} as const;

export function setStatus(text: string): void {
  dom.deviceStatus.textContent = text;
}

/**
 * Render a parameter value for reading.
 *
 * Values arrive as bytes and most are ASCII text, but not all: some carry raw octets, and rendering those
 * as characters produces mojibake that hides where the text stops and the binary starts. Printable runs are
 * kept as they are and anything else becomes `\xNN`, which is compact, unambiguous and reversible.
 *
 * The parser preserves each byte as one code unit, so nothing has been lost by the time this sees it.
 */
export function renderValue(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    out += code >= 0x20 && code <= 0x7e ? character : `\\x${code.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** Empty the readings. The only thing that does — nothing clears them on the app's own initiative. */
export function clearResult(): void {
  dom.result.textContent = "";
}

/** Empty the log. Same rule: it goes when asked and not before. */
export function clearLog(): void {
  dom.log.textContent = "";
}

/**
 * Add one line to the result area, keeping what is already there.
 *
 * A sweep of 146 parameters takes long enough that replacing the result each time would show only the last
 * one. Answers also arrive out of the order they were asked in, so the reading order is the arrival order
 * and not the parameter number — sorting as they land would make a slow read look like a stuck one.
 */
export function appendResult(text: string): void {
  dom.result.textContent = dom.result.textContent ? `${dom.result.textContent}\n${text}` : text;
  dom.result.scrollTop = dom.result.scrollHeight;
}

/**
 * Append to the running record, timestamped.
 *
 * The element sits outside the block hidden on disconnect — the log is most valuable at exactly the moment
 * the device goes away — and it is emptied only when asked.
 */
export function log(text: string): void {
  const at = new Date().toISOString().slice(11, 23);
  // Empty is empty. What an empty pane *says* is a presentational matter and lives in the stylesheet, so
  // nothing here has to know the placeholder's wording or compare against it.
  const previous = dom.log.textContent;
  dom.log.textContent = previous ? `${previous}\n${at}  ${text}` : `${at}  ${text}`;
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
