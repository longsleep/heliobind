import { describe, expect, test } from "bun:test";

import { ascii, toHex } from "./frame.ts";
import {
  BATTERY_REGISTERS,
  batteryFrom,
  CELL_TOLERANCE,
  MAX_COUNT,
  ModbusError,
  modbusBody,
  modelOf,
  NotServedError,
  parseRegisters,
  readPdu,
  VERSION_READS,
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

  test("reports an answer with no register data as not served", () => {
    // What a NOAH 2000 sends for a start register nothing behind its datalogger serves: its serial, a
    // declared PDU length of zero, and nothing after.
    const empty = new Uint8Array([0x30, 0x50, 0x56, 0x50, 0x43, 0x30, 0x45, 0x44, 0x33, 0x35, 0x00, 0x00]);
    expect(() => parseRegisters(empty, 119)).toThrow(NotServedError);
    expect(() => parseRegisters(empty, 119)).toThrow(/not served/);
  });

  test("keeps the octets of a reply it cannot read", () => {
    // The whole body in the message, because the first reply nobody has seen is evidence.
    expect(() => parseRegisters(reply([0x01, 0x03]), 322)).toThrow(/30 45 58 41/);
  });
});

describe("versionsFrom", () => {
  test("splits a NEXA's two registers into four components", () => {
    // 0x0e0c and 0x0e0b, which is what the reference device reports through its telemetry frame:
    // inverter 14, MPPT 12, PD 14, BMS 11.
    expect(versionsFrom([0x0e0c, 0x0e0b], "nexa")).toEqual({ inverter: 14, mppt: 12, pd: 14, bms: 11 });
  });

  test("takes a NOAH's versions from the end of its read, with no inverter", () => {
    // A NOAH 2000's reply to input 105 x 16: 119 = 0x0013 and 120 = 0x140e, MPPT 19, PD 20, BMS 14. The PD
    // matches the vendor's PP2110.20 campaign file for that model.
    const values = new Array<number>(16).fill(0);
    values[4] = 5020; // 109, the DC output
    values[14] = 0x0013;
    values[15] = 0x140e;
    expect(versionsFrom(values, "noah")).toEqual({ mppt: 19, pd: 20, bms: 14 });
  });

  test("refuses a short answer rather than reporting a version of zero", () => {
    expect(() => versionsFrom([0x0e0c], "nexa")).toThrow(ModbusError);
    expect(() => versionsFrom([0x0013, 0x140e], "noah")).toThrow(ModbusError);
  });

  test("every model's read stays within what this app will ask for and ends at 120", () => {
    for (const { start, count } of Object.values(VERSION_READS)) {
      expect(count).toBeLessThanOrEqual(MAX_COUNT);
      expect(start + count - 1).toBe(120);
    }
  });
});

describe("modelOf", () => {
  test("knows the NEXA and the NOAH by type code, and nothing else", () => {
    expect(modelOf(72)).toBe("nexa");
    expect(modelOf(61)).toBe("noah");
    expect(modelOf(66)).toBeUndefined();
  });
});

describe("batteryFrom", () => {
  /** A reply shaped like the reference device's: 99 to 112, with the registers between them left as read. */
  const block = (cellMax: number, cellMin: number, input: number): number[] => {
    const values = new Array<number>(BATTERY_REGISTERS.count).fill(0);
    values[0] = cellMax; // 99
    values[1] = cellMin; // 100
    values[2] = 32; // 101, cycles
    values[3] = 90; // 102, health
    values[13] = input; // 112, the inverter's input
    return values;
  };
  /** Register 118 while discharging at 5.6 A, and while idle. */
  const discharging = 29944;
  const idle = 30000;

  test("scales the block and calls a real reply consistent", () => {
    // Taken from the device while discharging: 3.312 and 3.310 V a cell, 52.7 V at the inverter's input.
    const battery = batteryFrom(block(3312, 3310, 527), discharging);
    expect(battery.cellMax).toBeCloseTo(3.312, 3);
    expect(battery.cellMin).toBeCloseTo(3.31, 3);
    expect(battery.pack).toBeCloseTo(52.98, 2);
    expect(battery.cycles).toBe(32);
    expect(battery.health).toBe(90);
    expect(battery.check?.inverterInput).toBeCloseTo(52.7, 1);
    expect(battery.check?.current).toBeCloseTo(-5.6, 1);
    expect(battery.check?.consistent).toBe(true);
  });

  test("the ratio sits just under one, and that is the reply being right", () => {
    // The mean of the highest and lowest cell overstates the mean cell, so a correct reply lands near
    // 0.996 rather than on 1. A test asserting 1.000 would fail against the device.
    const ratio = batteryFrom(block(3312, 3310, 527), discharging).check!.ratio;
    expect(ratio).toBeGreaterThan(1 - CELL_TOLERANCE);
    expect(ratio).toBeLessThan(1);
  });

  test("a misparsed input voltage is caught under load", () => {
    // What a byte-swapped or wrongly scaled 112 would look like. The check exists for exactly this: under
    // load the cells and the inverter's input must agree, so a disagreement is the reply's fault.
    expect(batteryFrom(block(3312, 3310, 5270), discharging).check?.consistent).toBe(false);
    expect(batteryFrom(block(3312, 3310, 52), discharging).check?.consistent).toBe(false);
  });

  test("an idle battery is not checked, and its pack voltage still comes from the cells", () => {
    // Seen on the device at the discharge floor: 112 swinging between 18 and 58 V while the cells held
    // 3.286 and 3.285 V and no current flowed. Calling that inconsistent would blame a correct reply.
    for (const input of [180, 583]) {
      const battery = batteryFrom(block(3286, 3285, input), idle);
      expect(battery.check).toBeDefined();
      expect(battery.check?.consistent).toBeUndefined();
      expect(battery.pack).toBeCloseTo(52.57, 2);
    }
  });

  test("below half an amp counts as idle, from it as under load", () => {
    expect(batteryFrom(block(3286, 3285, 180), 29996).check?.consistent).toBeUndefined();
    expect(batteryFrom(block(3286, 3285, 180), 30005).check?.consistent).toBe(false);
  });

  test("a model without an inverter gets its readings and no check", () => {
    // A NOAH 2000's reply: cells, cycles and health where a NEXA keeps them, 112 at zero. Checked, that
    // zero would read as an inconsistent reply on every press.
    const battery = batteryFrom(block(3351, 3350, 0), undefined);
    expect(battery.pack).toBeCloseTo(53.6, 1);
    expect(battery.cycles).toBe(32);
    expect(battery.health).toBe(90);
    expect(battery.check).toBeUndefined();
  });

  test("refuses a short reply rather than reading past it", () => {
    expect(() => batteryFrom([3312, 3310, 32], discharging)).toThrow(ModbusError);
  });

  test("cells reading zero are inconsistent under load, not a division by zero", () => {
    expect(batteryFrom(block(0, 0, 0), discharging).check?.ratio).toBe(0);
    expect(batteryFrom(block(0, 0, 0), discharging).check?.consistent).toBe(false);
  });

  test("the range stays within what this app will ask for", () => {
    expect(BATTERY_REGISTERS.count).toBeLessThanOrEqual(MAX_COUNT);
    // 99 and 100 are the cells, 112 the inverter's input: the range has to span them and is the shortest
    // that does.
    expect(BATTERY_REGISTERS.start).toBe(99);
    expect(BATTERY_REGISTERS.start + BATTERY_REGISTERS.count - 1).toBe(112);
  });
});
