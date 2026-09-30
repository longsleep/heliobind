import { describe, expect, test } from "bun:test";

import { ascii, toHex } from "./frame.ts";
import {
  BATTERY_REGISTERS,
  batteryFrom,
  CELL_TOLERANCE,
  MAX_COUNT,
  ModbusError,
  modbusBody,
  parseRegisters,
  readPdu,
  versionsFrom,
} from "./modbus.ts";

describe("readPdu", () => {
  test("builds the documented read of the paired-meter flag", () => {
    // Input register 295 is where the sub-MCU mirrors a paired LoRa meter's pairing state. The checksum
    // is computed here and in the research repository's specification independently; a disagreement means
    // one of the two is wrong.
    expect(toHex(readPdu("input", 295, 1))).toBe("01 04 01 27 00 01 80 3d");
  });

  test("the space is the function code and nothing else", () => {
    expect(toHex(readPdu("holding", 322, 1))).toBe("01 03 01 42 00 01 25 e2");
    expect(readPdu("input", 322, 1)[1]).toBe(0x04);
    expect(readPdu("holding", 322, 1)[1]).toBe(0x03);
  });

  test("the checksum goes out low octet first", () => {
    // The opposite order to the frame carrying it. Asserted rather than assumed: a reversed checksum
    // draws silence rather than an error, which is indistinguishable from an unsupported request.
    const pdu = readPdu("holding", 322, 1);
    expect([pdu[6], pdu[7]]).toEqual([0x25, 0xe2]);
  });

  test("refuses a count outside what it will ask for", () => {
    expect(() => readPdu("input", 250, 0)).toThrow(ModbusError);
    expect(() => readPdu("input", 250, MAX_COUNT + 1)).toThrow(ModbusError);
    expect(() => readPdu("input", 0xfff8, 16)).toThrow(ModbusError);
    expect(readPdu("input", 250, MAX_COUNT)).toHaveLength(8);
  });
});

describe("modbusBody", () => {
  test("is the serial, the length and the PDU", () => {
    const body = modbusBody(readPdu("input", 295, 1));
    expect(toHex(body)).toBe("30 30 30 30 30 30 30 30 30 30 00 08 01 04 01 27 00 01 80 3d");
  });
});

describe("parseRegisters", () => {
  /** A reply as the device sends one: its own serial, the PDU's length, then the PDU verbatim. */
  function reply(pdu: number[]): Uint8Array<ArrayBuffer> {
    const body = new Uint8Array(12 + pdu.length);
    body.set(ascii("0EXAMPLE00"), 0);
    body[10] = (pdu.length >>> 8) & 0xff;
    body[11] = pdu.length & 0xff;
    body.set(pdu, 12);
    return body;
  }

  test("reads the reply observed from the device", () => {
    // Captured reading holding register 322 with heliobind, the first register this app ever read. The
    // serial is the device's own, so it is redacted here; everything after it is byte for byte what came
    // back, and 100 W is what the MQTT transport returns for the same register.
    const observed = reply([0x01, 0x03, 0x02, 0x00, 0x64, 0xb9, 0xaf]);
    expect(observed).toHaveLength(19);
    const answer = parseRegisters(observed, 322);
    expect(answer.values).toEqual([100]);
    expect(answer.serial).toBe("0EXAMPLE00");
  });

  test("reads one register back", () => {
    // 01 03 02 0064 — holding register 322 holding 100, which is what 0x05 returns for it over MQTT.
    const answer = parseRegisters(reply([0x01, 0x03, 0x02, 0x00, 0x64, 0xb9, 0xaf]), 322);
    expect(answer.values).toEqual([100]);
    expect(answer.start).toBe(322);
  });

  test("rejects a PDU whose checksum does not match", () => {
    expect(() => parseRegisters(reply([0x01, 0x03, 0x02, 0x00, 0x64, 0x00, 0x00]), 322)).toThrow(/checksum/);
  });

  test("reports a Modbus exception as one", () => {
    // Function code with the exception bit set, then the exception code.
    expect(() => parseRegisters(reply([0x01, 0x83, 0x02, 0xc0, 0xf1]), 322)).toThrow(/refused/);
  });

  test("keeps the octets of a reply it cannot read", () => {
    // The whole body in the message, because the first reply nobody has seen is evidence.
    expect(() => parseRegisters(reply([0x01, 0x03]), 322)).toThrow(/30 45 58 41/);
  });
});

describe("versionsFrom", () => {
  test("splits the two registers into four components", () => {
    // 0x0e0c and 0x0e0b, which is what the reference device reports through its telemetry frame:
    // inverter 14, MPPT 12, PD 14, BMS 11.
    expect(versionsFrom([0x0e0c, 0x0e0b])).toEqual({ inverter: 14, mppt: 12, pd: 14, bms: 11 });
  });

  test("refuses a short answer rather than reporting a version of zero", () => {
    expect(() => versionsFrom([0x0e0c])).toThrow(ModbusError);
  });
});

describe("batteryFrom", () => {
  /** A reply shaped like the reference device's: 99 to 112, with the registers between them left as read. */
  const block = (cellMax: number, cellMin: number, pack: number): number[] => {
    const values = new Array<number>(BATTERY_REGISTERS.count).fill(0);
    values[0] = cellMax; // 99
    values[1] = cellMin; // 100
    values[2] = 32; // 101, cycles
    values[3] = 90; // 102, health
    values[13] = pack; // 112
    return values;
  };

  test("scales the block and calls a real reply consistent", () => {
    // Taken from the device while discharging: 3.312 and 3.310 V a cell, 52.7 V a pack.
    const battery = batteryFrom(block(3312, 3310, 527));
    expect(battery.cellMax).toBeCloseTo(3.312, 3);
    expect(battery.cellMin).toBeCloseTo(3.31, 3);
    expect(battery.pack).toBeCloseTo(52.7, 1);
    expect(battery.cycles).toBe(32);
    expect(battery.health).toBe(90);
    expect(battery.consistent).toBe(true);
  });

  test("the ratio sits just under one, and that is the reply being right", () => {
    // The mean of the highest and lowest cell overstates the mean cell, so a correct reply lands near
    // 0.996 rather than on 1. A test asserting 1.000 would fail against the device.
    const battery = batteryFrom(block(3312, 3310, 527));
    expect(battery.ratio).toBeGreaterThan(1 - CELL_TOLERANCE);
    expect(battery.ratio).toBeLessThan(1);
  });

  test("a misparsed pack voltage is caught", () => {
    // What a byte-swapped or wrongly scaled 112 would look like. The check exists for exactly this: the
    // cells and the pack disagree, so the reply is wrong whatever the battery is doing.
    expect(batteryFrom(block(3312, 3310, 5270)).consistent).toBe(false);
    expect(batteryFrom(block(3312, 3310, 52)).consistent).toBe(false);
  });

  test("refuses a short reply rather than reading past it", () => {
    expect(() => batteryFrom([3312, 3310, 32])).toThrow(ModbusError);
  });

  test("a pack reading of zero is inconsistent, not a division by zero", () => {
    expect(batteryFrom(block(0, 0, 0)).ratio).toBe(0);
    expect(batteryFrom(block(0, 0, 0)).consistent).toBe(false);
  });

  test("the range stays within what this app will ask for", () => {
    expect(BATTERY_REGISTERS.count).toBeLessThanOrEqual(MAX_COUNT);
    // 99 and 100 are the cells, 112 the pack: the range has to span them and is the shortest that does.
    expect(BATTERY_REGISTERS.start).toBe(99);
    expect(BATTERY_REGISTERS.start + BATTERY_REGISTERS.count - 1).toBe(112);
  });
});
