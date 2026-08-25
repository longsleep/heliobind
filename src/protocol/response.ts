/**
 * Decoded response bodies.
 *
 * Every reply shares one shape, whether it answers a read or a write:
 *
 * ```text
 * <serial: 10 ASCII> <count: 2> <status: 1> [ <param: 2> <len: 2> <value: ASCII> ] * count
 * ```
 *
 * The TLVs are the same triples a request carries; a status octet ahead of them is the only difference. A
 * write acknowledgement is simply a response with no TLVs, which is why one parser serves both.
 *
 * Two observations about the serial, both useful to a client:
 *
 * - **The device sends its own**, not the `"0000000000"` placeholder every request carries. So the serial
 *   need not be known before talking to a device.
 * - **It is ten characters**, the first ten of the sixteen the device is labelled with. Treat it as an
 *   identifier fragment rather than the whole serial.
 */

import { type Bytes, fromAscii, readU16 } from "./frame.ts";

/** Length of the serial prefix every response opens with. */
const SERIAL_LEN = 10;

/** Offset of the status octet: past the serial and the count. */
const STATUS_AT = SERIAL_LEN + 2;

/** Smallest possible response: serial, count, status, no values. */
const MIN_LEN = STATUS_AT + 1;

export class ResponseError extends Error {}

/** One parameter and its value, as returned. */
export interface Value {
  readonly param: number;
  readonly value: string;
}

export interface Response {
  /** The device's own serial, ten characters. */
  readonly serial: string;
  /**
   * How many parameters the request addressed — **not** how many values came back.
   *
   * A write acknowledgement carries the count with no values at all: presenting the handshake key answers
   * with a count of one and an empty body. Only a read returns a value per parameter.
   */
  readonly count: number;
  /** Zero means the request was accepted. */
  readonly status: number;
  readonly values: readonly Value[];
}

/** Whether a response reports success. */
export function accepted(response: Response): boolean {
  return response.status === 0;
}

/**
 * Parse a decrypted, length-trimmed response body.
 *
 * The TLV run is walked until the body is exhausted rather than until the count is reached, because the
 * count describes the request and not the reply — an acknowledgement carries a count of one and no values.
 * A truncated value is still an error: a short read would otherwise surface as a plausible-looking empty
 * string.
 */
export function parseResponse(body: Bytes): Response {
  if (body.length < MIN_LEN) {
    throw new ResponseError(`response is ${body.length} octets, shorter than the ${MIN_LEN} it must have`);
  }

  const serial = fromAscii(body.subarray(0, SERIAL_LEN));
  const count = readU16(body, SERIAL_LEN);
  const status = body[STATUS_AT]!;

  const values: Value[] = [];
  let at = MIN_LEN;
  while (at < body.length) {
    if (at + 4 > body.length) {
      throw new ResponseError(`a parameter header is cut short ${body.length - at} octets from the end`);
    }
    const param = readU16(body, at);
    const length = readU16(body, at + 2);
    if (at + 4 + length > body.length) {
      throw new ResponseError(`parameter ${param} claims ${length} octets, more than the body holds`);
    }
    values.push({ param, value: fromAscii(body.subarray(at + 4, at + 4 + length)) });
    at += 4 + length;
  }

  // Checked only when values are present. An empty body is an acknowledgement, not a short read, and the
  // count then refers to what was asked rather than what came back.
  if (values.length > 0 && values.length !== count) {
    throw new ResponseError(`count says ${count} parameters, the body holds ${values.length}`);
  }

  return { serial, count, status, values };
}
