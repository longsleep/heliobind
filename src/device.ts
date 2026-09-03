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
import { build, FUNCTION, parse, readConfigBody, writeConfigBody } from "./protocol/frame.ts";
import { BLE_HANDSHAKE_KEY, batches, everyParam } from "./protocol/params.ts";
import { accepted, parseResponse, type Response } from "./protocol/response.ts";
import type { Connection, Route } from "./transport/ble.ts";

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
    private readonly connection: Connection,
    /** The serial the device reported during the handshake — ten characters, its own rather than ours. */
    readonly serial: string,
  ) {}

  /**
   * Connect, authenticate, and return a usable session.
   *
   * @throws {AuthenticationError} if the device refuses the key.
   */
  static async open(connection: Connection, key: string): Promise<Device> {
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
  connection: Connection,
  fn: number,
  body: ReturnType<typeof readConfigBody>,
  route?: Route,
): Promise<Response> {
  const frame = build(fn, await encryptBody(body), body.length);
  const reply = route ? await connection.requestVia(frame, route) : await connection.request(frame);

  const parsed = parse(reply);
  const plain = (await decryptBody(parsed.body)).subarray(0, parsed.plaintextLen);
  return parseResponse(plain);
}
