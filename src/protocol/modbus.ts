/**
 * Function `0x17`: a Modbus RTU frame carried inside a Bluetooth frame.
 *
 * The register spaces this transport can reach that no other can. `0x18`/`0x19` address the datalogger's
 * *configuration* parameters; this addresses the component behind it, holding and input, by handing a
 * complete Modbus request to the datalogger, which passes it to that component untouched and hands the raw
 * answer back. Which registers exist and what they hold is that component's firmware's business, not this
 * module's — see {@link VERSION_REGISTERS}.
 *
 * ```text
 * request body   <serial: 10 ASCII> <pdu length: 2 BE> <pdu>
 * request pdu    <unit: 1> <function: 1> <start: 2 BE> <count: 2 BE> <crc: 2 LE>
 * reply body     <serial: 10 ASCII> <pdu length: 2 BE> <pdu>
 * reply pdu      <unit: 1> <function: 1> <octets: 1> <values: 2 each> <crc: 2 LE>
 * ```
 *
 * Both directions carry the same three fields. The serial differs: a request carries the placeholder every
 * request on this transport carries, and a reply carries the device's own — the same ten characters a
 * configuration response opens with.
 *
 * Observed, reading holding register 322:
 *
 * ```text
 * 30 48 56 52 44 30 5a 52 32 34  00 07  01 03 02 00 64 b9 af
 * └ the device's serial          └ 7    └ unit 1, function 3, two octets, 0x0064 = 100, checksum
 * ```
 *
 * 100 W is what `default_output_power` held, and what the MQTT transport returns for the same register —
 * which is the point of reading a holding register first.
 *
 * # Two checksums, in opposite orders
 *
 * The frame around this carries CRC-16/MODBUS **big-endian**, as every other frame on this transport does.
 * The PDU inside carries the same algorithm **little-endian**, which is ordinary Modbus RTU. Getting the
 * inner one backwards produces silence rather than an error — the sub-MCU drops a frame whose checksum
 * does not match — so it would look like an unresponsive device.
 *
 * # Why this exists here and not on the network transport
 *
 * The datalogger accepts `0x17` on its MQTT interface too, and there it does nothing at all: the handler
 * stages the request into structures nothing reads, so the request is inert. The Bluetooth handler is a
 * different piece of code and is wired straight through — it copies the PDU into the Modbus master's
 * buffer, transmits it under the same bus lock the working reads use, waits 1.5 s, and copies the raw
 * reply back. See `FINDINGS.md` F148 and `BLE-FINDINGS.md` B19 in the research repository.
 *
 * # Reads only
 *
 * This module builds function `0x03` and `0x04` requests and nothing else. The path would carry a write
 * just as happily, and a write to an inverter register from an app whose job is provisioning would be a
 * surprise with no undo.
 */

import {
  ascii,
  type Bytes,
  crc16,
  FrameError,
  fromAscii,
  readU16,
  SERIAL_PLACEHOLDER,
  toHex,
  writeU16,
} from "./frame.ts";

/** Unit address of the sub-MCU behind the datalogger. The same `0x01` the frame header carries. */
export const UNIT = 0x01;

/** Register spaces, named by the Modbus function code that selects one. */
export const SPACE = {
  /** Settings — the same registers the MQTT transport writes. */
  holding: 0x03,
  /** Telemetry, including the range no periodic report carries. */
  input: 0x04,
} as const;

export type Space = keyof typeof SPACE;

/** Octets in a read PDU: unit, function, start, count, CRC. */
export const READ_PDU_LEN = 8;

/**
 * Largest count this will ask for.
 *
 * Modbus allows 125. This is far below it on purpose: the datalogger copies the declared length into a
 * fixed buffer without checking it, and nothing here has any reason to send a long one.
 */
export const MAX_COUNT = 16;

/** The exception bit a Modbus device sets in the function code of a refusal. */
const EXCEPTION_BIT = 0x80;

/** Length of the serial every reply on this transport opens with. */
const SERIAL_LEN = 10;

export class ModbusError extends Error {}

/**
 * The PDU for a read, checksum included.
 *
 * The checksum is little-endian — see the module documentation for why that is worth stating twice.
 */
export function readPdu(space: Space, start: number, count: number): Bytes {
  if (!Number.isInteger(start) || start < 0 || start > 0xffff) {
    throw new ModbusError(`start ${start} is not a register number`);
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new ModbusError(`count ${count} is not between 1 and ${MAX_COUNT}`);
  }
  if (start + count - 1 > 0xffff) {
    throw new ModbusError(`registers ${start}..${start + count - 1} run past the register space`);
  }

  const pdu = new Uint8Array(READ_PDU_LEN);
  pdu[0] = UNIT;
  pdu[1] = SPACE[space];
  writeU16(pdu, 2, start);
  writeU16(pdu, 4, count);
  const crc = crc16(pdu.subarray(0, 6));
  pdu[6] = crc & 0xff;
  pdu[7] = (crc >>> 8) & 0xff;
  return pdu;
}

/** Body of a `0x17` request: the serial, the PDU's length, the PDU. */
export function modbusBody(pdu: Bytes, serial = SERIAL_PLACEHOLDER): Bytes {
  const id = ascii(serial);
  const out = new Uint8Array(id.length + 2 + pdu.length);
  out.set(id, 0);
  writeU16(out, id.length, pdu.length);
  out.set(pdu, id.length + 2);
  return out;
}

/** What came back. */
export interface Registers {
  /** The device's own serial, ten characters, as every reply on this transport reports it. */
  readonly serial: string;
  /** First register asked for, echoed from the request: the reply does not carry it. */
  readonly start: number;
  /** One value per register, in order. */
  readonly values: readonly number[];
  /** The reply PDU as it arrived, for a caller that wants the octets. */
  readonly pdu: Bytes;
}

/**
 * Parse a `0x17` reply body.
 *
 * Every failure carries the whole body as hex. That is not defensive habit: the first reply this app ever
 * received was misread by a parser written against the firmware, and the hex is what identified the field
 * it had got wrong in one glance.
 */
export function parseRegisters(body: Bytes, start: number): Registers {
  if (body.length < SERIAL_LEN + 2 + 5) {
    throw new ModbusError(`reply is ${body.length} octets, too short to carry an answer: ${toHex(body)}`);
  }

  const serial = fromAscii(body.subarray(0, SERIAL_LEN));
  const declared = readU16(body, SERIAL_LEN);
  const pdu = body.subarray(SERIAL_LEN + 2);
  if (pdu.length !== declared) {
    throw new ModbusError(`reply declares a ${declared}-octet PDU and carries ${pdu.length}: ${toHex(body)}`);
  }

  const wanted = crc16(pdu.subarray(0, pdu.length - 2));
  const found = pdu[pdu.length - 2]! | (pdu[pdu.length - 1]! << 8);
  if (wanted !== found) {
    throw new ModbusError(
      `PDU checksum is ${hex16(found)}, computed ${hex16(wanted)} — whole reply: ${toHex(body)}`,
    );
  }

  const fn = pdu[1]!;
  if ((fn & EXCEPTION_BIT) !== 0) {
    throw new ModbusError(`the device refused it: function ${hex8(fn)}, exception ${hex8(pdu[2]!)}`);
  }

  const octets = pdu[2]!;
  if (octets % 2 !== 0 || 3 + octets + 2 !== pdu.length) {
    throw new ModbusError(
      `reply says ${octets} octets of values and holds ${pdu.length - 5}: ${toHex(body)}`,
    );
  }

  const values: number[] = [];
  for (let at = 3; at < 3 + octets; at += 2) {
    values.push(readU16(pdu, at));
  }
  return { serial, start, values, pdu };
}

/**
 * Where the sub-MCUs report their own firmware versions: two registers, four octets, four components.
 *
 * Both are served and both answer: the reference device reports inverter 14, MPPT 12, PD 14, BMS 11, the
 * same values its telemetry frame carries at those positions. 120 is the last register the sub-MCU serves
 * before the gap — 121 draws no reply — so this reads the very top of the block.
 */
export const VERSION_REGISTERS = { start: 119, count: 2 } as const;

/** What each component reports as its own firmware version. */
export interface Versions {
  readonly inverter: number;
  readonly mppt: number;
  readonly pd: number;
  readonly bms: number;
}

/**
 * Split the two version registers into their four components.
 *
 * High octet then low: 119 is the inverter and the MPPT, 120 is the power controller and the BMS.
 */
export function versionsFrom(values: readonly number[]): Versions {
  if (values.length < 2) throw new ModbusError(`expected two version registers, got ${values.length}`);
  const [first, second] = values as [number, number];
  return {
    inverter: (first >>> 8) & 0xff,
    mppt: first & 0xff,
    pd: (second >>> 8) & 0xff,
    bms: second & 0xff,
  };
}

function hex8(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

function hex16(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

/** Re-exported so callers need not reach into the frame module for it. */
export { FrameError };
