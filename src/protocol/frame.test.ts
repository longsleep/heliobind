import { describe, expect, test } from "bun:test";
import {
  ADDRESS,
  build,
  crc16,
  declaredLength,
  FrameError,
  FUNCTION,
  fromHex,
  PROTOCOL,
  parse,
  readConfigBody,
  readU16,
  SERIAL_PLACEHOLDER,
  toHex,
  writeConfigBody,
  writeU16,
} from "./frame.ts";

describe("crc16", () => {
  test("matches the vector the vendor left in its own CRC class", () => {
    // CRC16.main() prints calcCrc16({2, 5, 0, 3, -1, 0}). Signed -1 is 0xFF.
    expect(crc16(fromHex("02 05 00 03 ff 00"))).toBe(0x097c);
  });

  test("is CRC-16/MODBUS: the check value for the standard input", () => {
    // "123456789" is the conventional check string; CRC-16/MODBUS gives 0x4B37.
    expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x4b37);
  });

  test("an empty input leaves the initial value untouched", () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
  });
});

describe("u16 accessors", () => {
  test("are big-endian, matching the vendor's int2Byte and byte2Int", () => {
    const buffer = new Uint8Array(2);
    writeU16(buffer, 0, 0x1234);
    expect(toHex(buffer)).toBe("12 34");
    expect(readU16(buffer, 0)).toBe(0x1234);
  });

  test("refuse to run off the end rather than truncating", () => {
    expect(() => writeU16(new Uint8Array(1), 0, 1)).toThrow(FrameError);
    expect(() => readU16(new Uint8Array(1), 0)).toThrow(FrameError);
  });
});

describe("readConfigBody", () => {
  test("lays out serial, count, then the parameter numbers", () => {
    const body = readConfigBody([55]);
    expect(toHex(body)).toBe("30 30 30 30 30 30 30 30 30 30 00 01 00 37");
    //                        ^ "0000000000"                  ^cnt ^param 55
  });

  test("carries several parameters in order", () => {
    const body = readConfigBody([55, 60, 17]);
    expect(toHex(body.subarray(10))).toBe("00 03 00 37 00 3c 00 11");
  });

  test("rejects an empty request", () => {
    expect(() => readConfigBody([])).toThrow(FrameError);
  });
});

describe("writeConfigBody", () => {
  test("adds a TLV byte count the read form does not have", () => {
    const body = writeConfigBody([{ param: 56, value: "net" }]);
    // serial(10) | count=1 | tlvBytes=7 | param=56 | len=3 | "net"
    expect(toHex(body.subarray(10))).toBe("00 01 00 07 00 38 00 03 6e 65 74");
  });

  test("concatenates entries and counts all their octets", () => {
    const body = writeConfigBody([
      { param: 56, value: "ssid" },
      { param: 57, value: "secret" },
    ]);
    expect(readU16(body, 10)).toBe(2);
    expect(readU16(body, 12)).toBe(4 + 4 + 4 + 6);
    expect(body.length).toBe(10 + 4 + 8 + 10);
  });

  test("refuses a non-ASCII value rather than mangling it", () => {
    expect(() => writeConfigBody([{ param: 56, value: "café" }])).toThrow(FrameError);
  });
});

describe("build and parse", () => {
  const body = readConfigBody([55]);
  // Stand in for a ciphertext: the same length rounded up to a block, which is what encryption produces.
  const encrypted = new Uint8Array(Math.ceil((body.length + 1) / 16) * 16).fill(0xaa);

  test("writes the header the protocol specifies", () => {
    const frame = build(FUNCTION.readConfig, encrypted, body.length);
    expect(readU16(frame, 0)).toBe(frame.length - 2);
    expect(readU16(frame, 2)).toBe(PROTOCOL);
    expect(readU16(frame, 4)).toBe(body.length + 2);
    expect(frame[6]).toBe(ADDRESS);
    expect(frame[7]).toBe(FUNCTION.readConfig);
  });

  test("round-trips through parse", () => {
    const frame = build(FUNCTION.readConfig, encrypted, body.length);
    const parsed = parse(frame);
    expect(parsed.protocol).toBe(PROTOCOL);
    expect(parsed.function).toBe(FUNCTION.readConfig);
    expect(parsed.plaintextLen).toBe(body.length);
    expect(toHex(parsed.body)).toBe(toHex(encrypted));
  });

  test("rejects a corrupted CRC", () => {
    const frame = build(FUNCTION.readConfig, encrypted, body.length);
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 0x01;
    expect(() => parse(frame)).toThrow(/CRC mismatch/);
  });

  test("rejects a length field that disagrees with the frame", () => {
    const frame = build(FUNCTION.readConfig, encrypted, body.length);
    writeU16(frame, 0, 999);
    expect(() => parse(frame)).toThrow(/declares/);
  });

  test("rejects a runt", () => {
    expect(() => parse(new Uint8Array(4))).toThrow(/shorter than/);
  });
});

describe("declaredLength", () => {
  test("reads the total length before the rest has arrived", () => {
    const frame = build(FUNCTION.readConfig, new Uint8Array(16), 3);
    expect(declaredLength(frame.subarray(0, 2))).toBe(frame.length);
  });

  test("waits for two octets", () => {
    expect(declaredLength(new Uint8Array(1))).toBeNull();
  });
});

test("the serial placeholder is the ten characters the vendor app sends", () => {
  expect(SERIAL_PLACEHOLDER).toBe("0000000000");
  expect(SERIAL_PLACEHOLDER.length).toBe(10);
});
