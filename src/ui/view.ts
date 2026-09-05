/**
 * The document: element handles, and the functions that turn values into text.
 *
 * Everything here is about presentation. It holds no state and performs no I/O, so the controller in
 * `app.ts` is left with nothing but the sequence of events — which is the part worth reading.
 */

import { describe, type Group, label, type Param } from "../protocol/params.ts";
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
  secrets: el<HTMLDetailsElement>("secrets"),
  secretsAbsent: el("secrets-absent"),
  secretsSupplied: el("secrets-supplied"),
  cipherKey: el<HTMLInputElement>("cipher-key"),
  cipherIv: el<HTMLInputElement>("cipher-iv"),
  keyBuiltinRow: el("key-builtin-row"),
  keyBuiltin: el<HTMLInputElement>("key-builtin"),
  keyOwn: el("key-own"),
  key: el<HTMLInputElement>("key"),
  forget: el<HTMLButtonElement>("forget"),
  connect: el<HTMLButtonElement>("connect"),
  device: el("device"),
  deviceName: el("device-name"),
  deviceStatus: el("device-status"),
  deviceSerial: el("device-serial"),
  readout: el("readout"),
  param: el<HTMLSelectElement>("param"),
  batch: el<HTMLSelectElement>("batch"),
  read: el<HTMLButtonElement>("read"),
  readProvisioning: el<HTMLButtonElement>("read-provisioning"),
  readSpace: el<HTMLButtonElement>("read-space"),
  info: el<HTMLButtonElement>("info"),
  writer: el<HTMLDetailsElement>("writer"),
  configure: el<HTMLDetailsElement>("configure"),
  groups: el("groups"),
  restart: el<HTMLButtonElement>("restart"),
  restartAfter: el<HTMLInputElement>("restart-after"),
  linkRouter: el("link-router"),
  linkServer: el("link-server"),
  linkNote: el("link-note"),
  linkStatus: el<HTMLButtonElement>("link-status"),
  writeParam: el<HTMLSelectElement>("write-param"),
  writeValue: el<HTMLInputElement>("write-value"),
  write: el<HTMLButtonElement>("write"),
  clearResult: el<HTMLButtonElement>("clear-result"),
  clearLog: el<HTMLButtonElement>("clear-log"),
  result: el<HTMLPreElement>("result"),
  log: el<HTMLPreElement>("log"),
  update: el("update"),
  updateNow: el<HTMLButtonElement>("update-now"),
  offer: el("offer"),
  install: el<HTMLButtonElement>("offer-install"),
  installLater: el<HTMLButtonElement>("offer-later"),
  build: el("build"),
} as const;

export function setStatus(text: string): void {
  dom.deviceStatus.textContent = text;
}

/**
 * How many parameters to name in one request.
 *
 * Falls back to one rather than trusting the control, because every value above it is a guess about a
 * transport nobody has measured, and one is the count the vendor app sends.
 */
export function batchSize(): number {
  const chosen = Number(dom.batch.value);
  return Number.isInteger(chosen) && chosen >= 1 ? chosen : 1;
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

/**
 * Render a reading, naming the value where the parameter carries a code.
 *
 * The value the device holds is what is reported — `72 (NEXA 2000)` — and the name follows it in
 * parentheses as a gloss. That order is deliberate: the code is what the specification tabulates and what
 * a reading taken over another transport shows, so it is the reading, and the name is help with it.
 */
export function renderReading(param: number, value: string): string {
  const rendered = renderValue(value);
  const named = label(param, value);
  return named ? `${rendered} (${named})` : rendered;
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
 *
 * **Traffic, not commentary.** What belongs here is the exchange in its own terms: registers, statuses,
 * octet counts, the codes behind a verdict. What was pressed and what came of it belongs in the readings
 * pane, in words. A message that would read the same in both panes goes in one of them — reporting a
 * failure twice makes it look like two failures, and makes a record of the traffic harder to read for the
 * commentary running through it.
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
    .map(
      ({ param, value }) =>
        `${String(param).padStart(3)}  ${describe(param).padEnd(16)}  ${renderReading(param, value)}`,
    )
    .join("\n");
}

/** Offer every known parameter, with its summary as a tooltip. */
export function fillParameters(params: readonly { number: number; name: string; summary: string }[]): void {
  fill(dom.param, params);
}

/** Offer the parameters this app is allowed to write, which is a much shorter list. */
export function fillWritable(params: readonly { number: number; name: string; summary: string }[]): void {
  fill(dom.writeParam, params);
  // Nothing to offer means nothing to write, so the fold is not worth showing at all.
  dom.writer.hidden = params.length === 0;
}

function fill(
  select: HTMLSelectElement,
  params: readonly { number: number; name: string; summary: string }[],
): void {
  for (const param of params) {
    const option = document.createElement("option");
    option.value = String(param.number);
    option.textContent = `${param.number} — ${param.name}`;
    option.title = param.summary;
    select.append(option);
  }
}

/**
 * Build a fieldset per write group, each with an input per parameter.
 *
 * The write button starts disabled and stays that way until the group has been read: a write sends only
 * what differs from what the device holds, and "what it holds" is not known until somebody asks. That is
 * the vendor's own sequence, and it is also what keeps a frame from re-asserting values nobody touched.
 */
export function renderGroups(
  groups: readonly Group[],
  handlers: { read: (group: Group) => void; write: (group: Group) => void },
): void {
  dom.groups.replaceChildren();
  for (const group of groups) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "group";
    fieldset.dataset.group = group.key;

    const legend = document.createElement("legend");
    legend.textContent = group.title;
    fieldset.append(legend);

    const summary = document.createElement("p");
    summary.className = "note";
    summary.textContent = group.summary;
    fieldset.append(summary);

    for (const param of group.params) {
      const input = document.createElement("input");
      input.id = fieldId(group, param);
      input.dataset.param = String(param.number);
      // Nothing is editable before a read, for the same reason the write button is not.
      input.disabled = true;

      const label = document.createElement("label");
      label.htmlFor = fieldId(group, param);
      label.title = param.summary;

      if (param.toggle) {
        // The box inside its own label, so the words are part of the target: a flag is easier to tick by
        // its text than by a box the size of a fingernail. The number stays visible, as it is on every
        // other row, because a parameter is identified here by its number before its name.
        input.type = "checkbox";
        label.className = "flag";
        label.append(input, document.createTextNode(`${param.number} — ${param.toggle.label}`));
        fieldset.append(label);
      } else {
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        label.textContent = `${param.number} — ${param.name}`;
        fieldset.append(label, input);
      }
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const read = document.createElement("button");
    read.type = "button";
    read.textContent = "Read";
    read.addEventListener("click", () => handlers.read(group));
    const write = document.createElement("button");
    write.type = "button";
    write.textContent = "Write changes";
    write.disabled = true;
    write.dataset.write = group.key;
    write.addEventListener("click", () => handlers.write(group));
    actions.append(read, write);
    fieldset.append(actions);

    dom.groups.append(fieldset);
  }
}

/** The input carrying one parameter of one group. */
export function groupField(group: Group, param: Param): HTMLInputElement | null {
  return document.getElementById(fieldId(group, param)) as HTMLInputElement | null;
}

/**
 * What a field holds, in the form the device takes it.
 *
 * A checkbox has no value of its own worth sending — `on` is what the browser calls a ticked box, not what
 * the device calls one — so the parameter's own two values answer for it.
 */
export function fieldValue(param: Param, field: HTMLInputElement): string {
  if (!param.toggle) return field.value;
  return field.checked ? param.toggle.on : param.toggle.off;
}

/**
 * Show a value the device sent.
 *
 * A flag holding neither of its two values shows as unticked, which is a guess — but the alternative is a
 * control with no state at all, and the diff before a write still names what it would send. Both of a
 * flag's values are documented, so a third is a discovery worth seeing in the readings pane beside it.
 */
export function showValue(param: Param, field: HTMLInputElement, value: string): void {
  if (param.toggle) {
    field.checked = value === param.toggle.on;
  } else {
    field.value = value;
  }
}

/**
 * What one of the device's two connection statuses means, in words.
 *
 * The values a parameter's own labels name are the ones that mean it worked. Anything else is a failure
 * whose meaning is not established here, so it is reported as a code rather than dressed up as an
 * explanation — "not joined (code 5)" is the whole of what is known, and reads as such.
 */
export function linkState(param: Param, value: string | undefined): string {
  const known = param.labels ?? {};
  // The positive word, taken from the labels rather than written twice. Every value a status parameter
  // labels is a success — the failures are the unlabelled ones.
  const worked = Object.values(known)[0] ?? "reported";
  if (value === undefined || value === "") return "no answer";
  return known[value] ?? `not ${worked} (code ${value})`;
}

/** Show what the device answered about its two connections. */
export function showLinks(router: string, server: string): void {
  dom.linkRouter.textContent = router;
  dom.linkServer.textContent = server;
}

/** Say why an answer might not mean what it appears to, or clear the remark. */
export function noteLinks(text: string | null): void {
  dom.linkNote.textContent = text ?? "";
  dom.linkNote.hidden = text === null;
}

/** Let a group be edited and written, once it has been read. */
export function groupReadable(group: Group, ready: boolean): void {
  for (const param of group.params) {
    const field = groupField(group, param);
    if (field) field.disabled = !ready;
  }
  const write = dom.groups.querySelector<HTMLButtonElement>(`[data-write="${group.key}"]`);
  if (write) write.disabled = !ready;
}

function fieldId(group: Group, param: Param): string {
  return `field-${group.key}-${param.number}`;
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
