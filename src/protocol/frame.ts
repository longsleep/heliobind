/**
 * Wire framing for the NEXA 2000 Bluetooth interface.
 *
 * The frame is the vendor's generation-7 MQTT frame with two changes: the protocol field carries 6 rather
 * than 7, and the body is AES-encrypted rather than XOR-obfuscated. Everything else — the eight-octet
 * header, the trailing CRC, the configuration key space — is shared.
 *
 * ```text
 * +--------+--------------+---------------+---------+----------+ ... +--------+
 * | 0..1   | 2..3         | 4..5          | 6       | 7        | 8..     | last 2 |
 * +--------+--------------+---------------+---------+----------+ ... +--------+
 * | length | protocol     | plaintext len | address | function | body    | CRC    |
 * | tot-2  | 0x0006       | plain + 2     | 0x01    |          | AES     |        |
 * +--------+--------------+---------------+---------+----------+ ... +--------+
 * ```
 *
 * Every multi-octet field is big-endian, including the CRC. The CRC being big-endian is a deviation from
 * Modbus RTU, which sends it low octet first; this protocol does not.
 */

/**
 * A byte array backed by a plain ArrayBuffer.
 *
 * The distinction matters: the modern lib types `Uint8Array` as generic over its buffer, and Web Crypto
 * accepts only ArrayBuffer-backed views. Naming it once keeps that out of every signature.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Offsets into the frame. The header is fixed width, so these are absolute. */
export const HEADER_LEN = 8;
export const CRC_LEN = 2;

/** Protocol version. The MQTT transport of the same device carries 7 here. */
export const PROTOCOL = 0x0006;

/** Unit address. Datalogger-scoped messages still arrive under 0x01 on this interface. */
export const ADDRESS = 0x01;

/** Function codes, shared with the MQTT configuration space. */
export const FUNCTION = {
  /** Write configuration parameters. Body is a TLV list. */
  writeConfig: 0x18,
  /** Read configuration parameters. Body is a list of parameter numbers. */
  readConfig: 0x19,
} as const;

/**
 * The serial the vendor app puts in every body — it discards the device identity it is passed and sends
 * this literal instead. On a point-to-point link the peer is already chosen by the GATT connection, so
 * there is nothing to disambiguate.
 */
export const SERIAL_PLACEHOLDER = "0000000000";

/** A parameter and its value, as carried in a write. */
export interface Tlv {
  readonly param: number;
  readonly value: string;
}

/** A parsed frame, before the body is decrypted. */
export interface ParsedFrame {
  readonly protocol: number;
  readonly address: number;
  readonly function: number;
  /** Length of the meaningful plaintext, once the body is decrypted: the field at 4..5 less two. */
  readonly plaintextLen: number;
  /** The encrypted body, block-aligned and possibly longer than `plaintextLen`. */
  readonly body: Bytes;
}

export class FrameError extends Error {}

/**
 * CRC-16/MODBUS, init 0xFFFF, polynomial 0xA001 reflected.
 *
 * Returned as an integer; `writeU16` puts it on the wire big-endian, which is what this protocol wants.
 */
export function crc16(data: Bytes): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

/** Write a 16-bit value big-endian. Mirrors the vendor's `int2Byte`. */
export function writeU16(into: Bytes, offset: number, value: number): void {
  if (offset + 2 > into.length) throw new FrameError(`no room for a u16 at ${offset}`);
  into[offset] = (value >>> 8) & 0xff;
  into[offset + 1] = value & 0xff;
}

/** Read a 16-bit value big-endian. Mirrors the vendor's `byte2Int`. */
export function readU16(from: Bytes, offset: number): number {
  if (offset + 2 > from.length) throw new FrameError(`no u16 available at ${offset}`);
  return ((from[offset]! & 0xff) << 8) | (from[offset + 1]! & 0xff);
}

/** ASCII bytes. The protocol carries serials and parameter values as plain ASCII. */
export function ascii(text: string): Bytes {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new FrameError(`value is not ASCII: ${JSON.stringify(text)}`);
    out[i] = code;
  }
  return out;
}

export function fromAscii(bytes: Bytes): string {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

/**
 * Body of a configuration read: the serial, a count, then the parameter numbers.
 *
 * ```text
 * <serial: ASCII> <count: u16> [ <param: u16> ] * count
 * ```
 */
export function readConfigBody(params: readonly number[], serial = SERIAL_PLACEHOLDER): Bytes {
  if (params.length === 0) throw new FrameError("a read needs at least one parameter");
  const id = ascii(serial);
  const out = new Uint8Array(id.length + 2 + params.length * 2);
  out.set(id, 0);
  writeU16(out, id.length, params.length);
  for (const [index, param] of params.entries()) {
    writeU16(out, id.length + 2 + index * 2, param);
  }
  return out;
}

/**
 * Body of a configuration write: the serial, a count, the byte length of the TLV run, then the TLVs.
 *
 * ```text
 * <serial: ASCII> <count: u16> <tlv bytes: u16> [ <param: u16> <len: u16> <value: ASCII> ] * count
 * ```
 *
 * Note the write form carries a byte count the read form does not.
 */
export function writeConfigBody(entries: readonly Tlv[], serial = SERIAL_PLACEHOLDER): Bytes {
  if (entries.length === 0) throw new FrameError("a write needs at least one parameter");
  const values = entries.map((entry) => ascii(entry.value));
  const tlvLen = values.reduce((total, value) => total + 4 + value.length, 0);

  const id = ascii(serial);
  const out = new Uint8Array(id.length + 4 + tlvLen);
  out.set(id, 0);
  writeU16(out, id.length, entries.length);
  writeU16(out, id.length + 2, tlvLen);

  let at = id.length + 4;
  entries.forEach((entry, index) => {
    const value = values[index]!;
    writeU16(out, at, entry.param);
    writeU16(out, at + 2, value.length);
    out.set(value, at + 4);
    at += 4 + value.length;
  });
  return out;
}

/**
 * Assemble a frame around an already-encrypted body.
 *
 * `plaintextLen` is the length of the body *before* encryption, which the receiver needs because the
 * ciphertext is block-aligned and therefore longer.
 */
export function build(fn: number, encryptedBody: Bytes, plaintextLen: number): Bytes {
  const frame = new Uint8Array(HEADER_LEN + encryptedBody.length + CRC_LEN);
  writeU16(frame, 0, HEADER_LEN + encryptedBody.length - 2 + CRC_LEN);
  writeU16(frame, 2, PROTOCOL);
  writeU16(frame, 4, plaintextLen + 2);
  frame[6] = ADDRESS;
  frame[7] = fn;
  frame.set(encryptedBody, HEADER_LEN);
  writeU16(frame, frame.length - CRC_LEN, crc16(frame.subarray(0, frame.length - CRC_LEN)));
  return frame;
}

/** Total frame length a header declares, or null if the header is not yet complete. */
export function declaredLength(bytes: Bytes): number | null {
  if (bytes.length < 2) return null;
  return readU16(bytes, 0) + 2;
}

/**
 * Parse a frame and verify its CRC. The body is returned still encrypted; decryption needs the key and
 * is deliberately not this module's business.
 */
export function parse(frame: Bytes): ParsedFrame {
  if (frame.length < HEADER_LEN + CRC_LEN) {
    throw new FrameError(`frame is ${frame.length} octets, shorter than a header and CRC`);
  }
  const declared = readU16(frame, 0) + 2;
  if (declared !== frame.length) {
    throw new FrameError(`header declares ${declared} octets, got ${frame.length}`);
  }

  const wanted = crc16(frame.subarray(0, frame.length - CRC_LEN));
  const found = readU16(frame, frame.length - CRC_LEN);
  if (wanted !== found) {
    throw new FrameError(`CRC mismatch: computed ${hex16(wanted)}, frame carries ${hex16(found)}`);
  }

  const plaintextLen = readU16(frame, 4) - 2;
  if (plaintextLen < 0) throw new FrameError("plaintext length field is less than two");

  return {
    protocol: readU16(frame, 2),
    address: frame[6]!,
    function: frame[7]!,
    plaintextLen,
    body: frame.subarray(HEADER_LEN, frame.length - CRC_LEN),
  };
}

function hex16(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

/** Hex, for logs and for tests that need to say what they expected. */
export function toHex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** Inverse of {@link toHex}, tolerating whitespace. */
export function fromHex(text: string): Bytes {
  const cleaned = text.replace(/\s+/g, "");
  if (cleaned.length % 2 !== 0) throw new FrameError("hex string has an odd length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new FrameError(`not hex: ${cleaned.slice(i * 2, i * 2 + 2)}`);
    out[i] = byte;
  }
  return out;
}
