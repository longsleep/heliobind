/**
 * An authenticated conversation with one device.
 *
 * The layer that ties framing and the cipher to the radio, so that nothing above it needs to know either.
 * `protocol/` stays pure and testable; `transport/` stays ignorant of what it carries; this is the only
 * place both appear.
 *
 * ## Authentication is not optional
 *
 * The device answers nothing until a key has been accepted. A read sent beforehand is discarded in silence —
 * no error, no refusal, nothing — so {@link Device.open} performs the handshake and fails if it is refused,
 * rather than handing back a session that appears usable and is not.
 */

import { decryptBody, encryptBody } from "./protocol/crypto.ts";
import {
  type Bytes,
  build,
  FUNCTION,
  parse,
  readConfigBody,
  type Tlv,
  writeConfigBody,
} from "./protocol/frame.ts";
import {
  modbusBody,
  parseRegisters,
  type Registers,
  readPdu,
  type Space,
  VERSION_REGISTERS,
  type Versions,
  versionsFrom,
} from "./protocol/modbus.ts";
import { BLE_HANDSHAKE_KEY, batches, describe, everyParam, isWritable } from "./protocol/params.ts";
import { accepted, parseResponse, type Response } from "./protocol/response.ts";
import type { Link, Route } from "./transport/link.ts";

export class DeviceError extends Error {}

/**
 * One outcome from {@link Device.sweep}.
 *
 * Three cases rather than two, because "the device returned nothing for this parameter" and "the request
 * never got an answer" are different facts and only one of them is a fault.
 */
export type Answer =
  | { readonly kind: "value"; readonly param: number; readonly value: string }
  | { readonly kind: "silent"; readonly params: readonly number[] }
  | { readonly kind: "unanswered"; readonly params: readonly number[]; readonly reason: string };

/** What went wrong, in a form fit to show. */
function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Refused by the device rather than failed in transit: the frame was understood, the key was not. */
export class AuthenticationError extends DeviceError {
  constructor(readonly status: number) {
    super(`the device refused the key, status ${status}`);
  }
}

export class Device {
  private constructor(
    private readonly connection: Link,
    /** The serial the device reported during the handshake — ten characters, its own rather than ours. */
    readonly serial: string,
  ) {}

  /**
   * Connect, authenticate, and return a usable session.
   *
   * @throws {AuthenticationError} if the device refuses the key.
   */
  static async open(connection: Link, key: string): Promise<Device> {
    const response = await exchange(
      connection,
      FUNCTION.writeConfig,
      writeConfigBody([{ param: BLE_HANDSHAKE_KEY.number, value: key }]),
    );
    if (!accepted(response)) throw new AuthenticationError(response.status);
    return new Device(connection, response.serial);
  }

  get connected(): boolean {
    return this.connection.connected;
  }

  /** Read one or more configuration parameters. */
  async read(params: readonly number[]): Promise<Response> {
    return exchange(this.connection, FUNCTION.readConfig, readConfigBody(params));
  }

  /**
   * Write one or more configuration parameters.
   *
   * Refused unless every parameter is on the allowlist in `params.ts`, and refused *here* rather than by
   * the device: this transport reaches the registers that decide which network the device joins and which
   * server it dials, and the device will accept a value that makes it unreachable as readily as any other.
   * The check is before a frame is built, so there is no path from this class to an octet on the wire that
   * skips it.
   *
   * The reply is an acknowledgement with no values: {@link accepted} on the status is the whole answer, and
   * a caller that wants to know what the device now holds has to read it back.
   *
   * @throws {DeviceError} if any parameter is not writable by this app.
   */
  async write(entries: readonly Tlv[]): Promise<Response> {
    const refused = entries.filter((entry) => !isWritable(entry.param));
    if (refused.length > 0) {
      const named = refused.map((entry) => `${describe(entry.param)} (${entry.param})`).join(", ");
      throw new DeviceError(`this app does not write ${named}`);
    }
    return exchange(this.connection, FUNCTION.writeConfig, writeConfigBody(entries));
  }

  /**
   * Read the whole parameter space, yielding each answer as it arrives.
   *
   * An async iterator rather than a promise of everything, because a sweep of 146 parameters takes long
   * enough that a caller should be able to show progress, stop early, or give up — and because the device
   * answers some parameters and not others, so there is no complete set to wait for.
   *
   * `batch` is how many parameters go in one request. It is a tuning knob and not an interface: the device
   * may honour it, or answer only the first and leave the rest unanswered, and a caller sees the same
   * sequence of values either way — only the time differs. One is the count the vendor app always sends and
   * so the only one certain to work.
   *
   * A batch that fails does not end the sweep. Its parameters are reported unanswered and the next batch
   * goes out, because one refusal should not cost the other 145.
   */
  async *sweep(batch = 1, params: readonly number[] = everyParam()): AsyncGenerator<Answer> {
    for (const group of batches(params, batch)) {
      let response: Response;
      try {
        response = await this.read(group);
      } catch (error) {
        yield { kind: "unanswered", params: group, reason: reasonFor(error) };
        continue;
      }
      for (const value of response.values) {
        yield { kind: "value", param: value.param, value: value.value };
      }
      // Asked for and not returned. Expected rather than exceptional — some parameters are simply empty —
      // so it is reported as an outcome and not as a failure.
      const answered = new Set(response.values.map((value) => value.param));
      const silent = group.filter((param) => !answered.has(param));
      if (silent.length > 0) {
        yield { kind: "silent", params: silent };
      }
    }
  }

  /**
   * Read registers from the controller behind the datalogger, holding or input.
   *
   * A different question from {@link read}, which asks the *datalogger* for its own configuration. This
   * asks the component the datalogger aggregates — on the device this was written against, a power
   * controller that mirrors what the inverter, the MPPT and the battery report — and it is the only way to
   * reach registers no periodic frame carries.
   *
   * **What the numbers mean is not this app's business.** The map belongs to that component's firmware,
   * and it has been seen to differ between releases of the same product; {@link componentVersions} is how
   * a caller finds out which one it is talking to.
   *
   * ⚠ **Unobserved.** No such exchange has ever been performed, on this transport or any other; the same
   * function code on the MQTT transport is accepted and does nothing at all. The Bluetooth handler is
   * separate code and is wired straight through to the Modbus master, which is the reason to expect this
   * one to work — not evidence that it does. Read a holding register the other transport can also read
   * before believing an input-register answer.
   *
   * Reads only: {@link readPdu} builds no other function code.
   */
  async readRegisters(space: Space, start: number, count = 1): Promise<Registers> {
    const plain = await raw(this.connection, FUNCTION.modbus, modbusBody(readPdu(space, start, count)));
    return parseRegisters(plain, start);
  }

  /**
   * What each component behind the datalogger reports as its own firmware version.
   *
   * Worth having because every register meaning this app knows was read out of one particular sub-MCU
   * image, and the device may be running a different one — the register map has held across two releases,
   * but "which firmware is this" is the first question to ask when a reading looks wrong.
   *
   * ⚠ **Which firmware serves this is itself version-dependent.** 119 and 120 are the last two registers
   * the reference device answers for — 121 draws nothing — and an older sub-MCU image stops at 117, so a
   * device running that one would refuse this read. A refusal is therefore an outcome worth reporting
   * rather than a fault.
   */
  async componentVersions(): Promise<Versions> {
    const answer = await this.readRegisters("input", VERSION_REGISTERS.start, VERSION_REGISTERS.count);
    return versionsFrom(answer.values);
  }

  /**
   * Read by a route other than the default, for working out how the device behaves.
   *
   * Kept because it answered a real question once — whether chunked writes or the write-without-response
   * characteristic made any difference — and the next such question will want it too.
   */
  async readVia(params: readonly number[], route: Route): Promise<Response> {
    return exchange(this.connection, FUNCTION.readConfig, readConfigBody(params), route);
  }
}

/**
 * One request and its reply: encrypt, frame, send, verify, decrypt, parse.
 *
 * The plaintext is trimmed to the length the header declares before parsing, because the cipher works in
 * whole blocks and the tail is padding rather than content.
 */
async function exchange(
  connection: Link,
  fn: number,
  body: ReturnType<typeof readConfigBody>,
  route?: Route,
): Promise<Response> {
  return parseResponse(await raw(connection, fn, body, route));
}

/**
 * One request and its reply, stopping at the decrypted plaintext.
 *
 * Split out of {@link exchange} because not every function answers with the configuration space's
 * serial-count-status-TLV shape: the Modbus passthrough answers with a Modbus frame. Everything up to the
 * plaintext is common, and everything after it is the caller's.
 */
async function raw(connection: Link, fn: number, body: Bytes, route?: Route): Promise<Bytes> {
  const frame = build(fn, await encryptBody(body), body.length);
  const reply = route ? await connection.requestVia(frame, route) : await connection.request(frame);

  const parsed = parse(reply);
  return (await decryptBody(parsed.body)).subarray(0, parsed.plaintextLen);
}
