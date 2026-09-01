import { describe, expect, test } from "bun:test";
import { fromHex } from "./frame.ts";
import { accepted, parseResponse, ResponseError } from "./response.ts";

/**
 * A stand-in serial, ten characters as the device sends.
 *
 * The structure of these vectors comes from real replies. Every value in them is invented: a captured
 * response carries the network name and passphrase of whichever device answered.
 */
const SERIAL = "30 45 58 41 4d 50 4c 45 30 30"; // "0EXAMPLE00"

describe("parseResponse", () => {
  test("reads a write acknowledgement, which counts the request and returns no values", () => {
    // What presenting the handshake key answers with: one parameter addressed, nothing returned.
    const response = parseResponse(fromHex(`${SERIAL} 00 01 00`));
    expect(response.serial).toBe("0EXAMPLE00");
    expect(response.count).toBe(1);
    expect(response.status).toBe(0);
    expect(response.values).toEqual([]);
    expect(accepted(response)).toBe(true);
  });

  test("reports a refusal without treating it as malformed", () => {
    const response = parseResponse(fromHex(`${SERIAL} 00 01 01`));
    expect(response.status).toBe(1);
    expect(accepted(response)).toBe(false);
  });

  test("reads one parameter", () => {
    // param 17, four octets, "host"
    const response = parseResponse(fromHex(`${SERIAL} 00 01 00 00 11 00 04 68 6f 73 74`));
    expect(response.values).toEqual([{ param: 17, value: "host" }]);
  });

  test("reads several parameters in order", () => {
    const response = parseResponse(fromHex(`${SERIAL} 00 02 00 00 38 00 02 69 64 00 39 00 03 70 77 64`));
    expect(response.values).toEqual([
      { param: 56, value: "id" },
      { param: 57, value: "pwd" },
    ]);
  });

  test("accepts an empty value, which is a legitimate answer", () => {
    const response = parseResponse(fromHex(`${SERIAL} 00 01 00 00 38 00 00`));
    expect(response.values).toEqual([{ param: 56, value: "" }]);
  });

  test("rejects a body too short to hold a status", () => {
    expect(() => parseResponse(fromHex(`${SERIAL} 00 01`))).toThrow(ResponseError);
  });

  test("rejects a value that runs past the end rather than truncating it", () => {
    // Claims 16 octets and supplies four. Silently returning "host" would be worse than failing.
    expect(() => parseResponse(fromHex(`${SERIAL} 00 01 00 00 11 00 10 68 6f 73 74`))).toThrow(
      /more than the body holds/,
    );
  });

  test("rejects a parameter header cut short", () => {
    expect(() => parseResponse(fromHex(`${SERIAL} 00 01 00 00 11 00`))).toThrow(/cut short/);
  });

  test("rejects a body carrying more values than the count", () => {
    expect(() => parseResponse(fromHex(`${SERIAL} 00 01 00 00 11 00 04 68 6f 73 74 00 12 00 01 39`))).toThrow(
      /count says 1/,
    );
  });

  test("accepts a body carrying fewer values than the count", () => {
    // A request may name several parameters and the device answers only the ones it holds. Rejecting that
    // would discard the values that did come back, which is the opposite of useful.
    const response = parseResponse(fromHex(`${SERIAL} 00 08 00 00 11 00 04 68 6f 73 74`));
    expect(response.count).toBe(8);
    expect(response.values).toEqual([{ param: 17, value: "host" }]);
  });
});
