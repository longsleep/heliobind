/**
 * Sweeping the parameter space, against a device made of code.
 *
 * The fake answers through the real cipher and the real framing, so a test exercises encrypt, build, parse,
 * decrypt and parseResponse on the way past. What it fakes is only the radio and what the device chooses to
 * say — which is exactly the part that is uncertain.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { type Answer, Device } from "./device.ts";
import { useTestCipher } from "./protocol/cipher.fixture.ts";
import { decryptBody, encryptBody } from "./protocol/crypto.ts";
import { type Bytes, build, FUNCTION, parse, readU16, SERIAL_PLACEHOLDER } from "./protocol/frame.ts";
import { ACCESSORY_LIST_LAN, FACTORY_RESET, PARAM_SPACE_LAST, WIFI_SSID } from "./protocol/params.ts";
import type { Link } from "./transport/link.ts";

beforeAll(useTestCipher);

const SERIAL = "0EXAMPLE00";

/** Build the reply body a device sends: its serial, a count, a status, then a TLV per value. */
function responseBody(values: readonly { param: number; value: string }[], count: number): Bytes {
  const text = new TextEncoder();
  const tlvs = values.map(({ param, value }) => {
    const bytes = text.encode(value);
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint16(0, param);
    new DataView(out.buffer).setUint16(2, bytes.length);
    out.set(bytes, 4);
    return out;
  });
  const size = 10 + 2 + 1 + tlvs.reduce((total, tlv) => total + tlv.length, 0);
  const body = new Uint8Array(size);
  body.set(text.encode(SERIAL), 0);
  new DataView(body.buffer).setUint16(10, count);
  body[12] = 0; // accepted
  let at = 13;
  for (const tlv of tlvs) {
    body.set(tlv, at);
    at += tlv.length;
  }
  return body;
}

/** Which parameters a read request asked for, recovered from the frame the app built. */
async function requestedParams(frame: Bytes): Promise<number[]> {
  const parsed = parse(frame);
  const plain = (await decryptBody(parsed.body)).subarray(0, parsed.plaintextLen);
  const count = readU16(plain, SERIAL_PLACEHOLDER.length);
  return Array.from({ length: count }, (_, index) =>
    readU16(plain, SERIAL_PLACEHOLDER.length + 2 + index * 2),
  );
}

interface FakeOptions {
  /** Values the device holds. Anything not here answers nothing. */
  readonly holds: ReadonlyMap<number, string>;
  /** How many of a batch it will answer, mimicking a device that ignores the count. */
  readonly answersPerRequest?: number;
  /** Parameters whose request blows up in transit. */
  readonly failsOn?: ReadonlySet<number>;
}

/** A device made of code, reachable through the same call the radio implements. */
function fakeConnection(options: FakeOptions): { connection: Link; requests: number[][] } {
  const requests: number[][] = [];
  const connection = {
    connected: true,
    // Part of the contract rather than of this fake's business: a name to show and a way to say the device
    // went away. Neither is exercised here, where the subject is what travels over the link.
    name: "fake",
    onDisconnected: null,
    async request(frame: Bytes): Promise<Bytes> {
      const parsed = parse(frame);
      // The handshake writes the key; answer it as accepted with no values.
      if (parsed.function === FUNCTION.writeConfig) {
        return reply(responseBody([], 1));
      }
      const params = await requestedParams(frame);
      requests.push(params);
      if (options.failsOn && params.some((param) => options.failsOn?.has(param))) {
        throw new Error("the radio dropped it");
      }
      const answerable = params.slice(0, options.answersPerRequest ?? params.length);
      const values = answerable
        .filter((param) => options.holds.has(param))
        .map((param) => ({ param, value: options.holds.get(param) ?? "" }));
      return reply(responseBody(values, params.length));
    },
  } as unknown as Link;
  return { connection, requests };
}

/**
 * Frame a body the way a reply arrives.
 *
 * Built with the request protocol rather than {@link PROTOCOL_REPLY}, because `parse` accepts either and
 * rewriting the field would mean recomputing the CRC over it for no gain here.
 */
async function reply(body: Bytes): Promise<Bytes> {
  return build(FUNCTION.readConfig, await encryptBody(body), body.length);
}

async function collect(device: Device, batch: number): Promise<Answer[]> {
  const out: Answer[] = [];
  for await (const answer of device.sweep(batch)) out.push(answer);
  return out;
}

describe("sweeping the parameter space", () => {
  test("asks for every parameter exactly once", async () => {
    const { connection, requests } = fakeConnection({ holds: new Map([[17, "mqtt.growatt.com"]]) });
    const device = await Device.open(connection, "key");
    await collect(device, 8);

    expect(requests.flat().length).toBe(PARAM_SPACE_LAST + 1);
    expect(new Set(requests.flat()).size).toBe(PARAM_SPACE_LAST + 1);
  });

  test("yields the values the device holds", async () => {
    const holds = new Map([
      [17, "mqtt.growatt.com"],
      [21, "4.0.1.9"],
    ]);
    const { connection } = fakeConnection({ holds });
    const device = await Device.open(connection, "key");
    const values = (await collect(device, 8)).filter((answer) => answer.kind === "value");

    expect(values).toContainEqual({ kind: "value", param: 17, value: "mqtt.growatt.com" });
    expect(values).toContainEqual({ kind: "value", param: 21, value: "4.0.1.9" });
    expect(values.length).toBe(2);
  });

  test("the batch size changes the request count, not the values", async () => {
    const holds = new Map([
      [17, "mqtt.growatt.com"],
      [76, "-63"],
    ]);
    const one = fakeConnection({ holds });
    const eight = fakeConnection({ holds });
    const valuesOf = (answers: Answer[]) => answers.filter((answer) => answer.kind === "value");

    const single = valuesOf(await collect(await Device.open(one.connection, "key"), 1));
    const batched = valuesOf(await collect(await Device.open(eight.connection, "key"), 8));

    expect(batched).toEqual(single);
    expect(one.requests.length).toBe(PARAM_SPACE_LAST + 1);
    expect(eight.requests.length).toBe(Math.ceil((PARAM_SPACE_LAST + 1) / 8));
  });

  test("a device that ignores the count still yields what it answers", async () => {
    // The case that decides whether batching is safe to offer: ask for eight, get one. The caller must see
    // the values that came back and be told which did not, rather than being handed a silent gap.
    const holds = new Map(Array.from({ length: 16 }, (_, n) => [n, `v${n}`] as const));
    const { connection } = fakeConnection({ holds, answersPerRequest: 1 });
    const device = await Device.open(connection, "key");
    const answers = await collect(device, 8);

    const values = answers.filter((answer) => answer.kind === "value");
    expect(values.map((value) => value.param)).toEqual([0, 8]);

    const silent = answers.filter((answer) => answer.kind === "silent").flatMap((answer) => answer.params);
    expect(silent).toContain(1);
    expect(silent).toContain(9);
  });

  test("a failed batch is reported and the sweep carries on", async () => {
    const { connection } = fakeConnection({
      holds: new Map([[145, "last"]]),
      failsOn: new Set([0]),
    });
    const device = await Device.open(connection, "key");
    const answers = await collect(device, 1);

    const unanswered = answers.filter((answer) => answer.kind === "unanswered");
    expect(unanswered.length).toBe(1);
    expect(unanswered[0]?.params).toEqual([0]);
    // The failure did not cost the rest of the space.
    expect(answers).toContainEqual({ kind: "value", param: 145, value: "last" });
  });
});

describe("writing a setting", () => {
  /** Recover the TLVs from a write frame the app built, which is what the device would act on. */
  async function writtenEntries(frame: Bytes): Promise<{ param: number; value: string }[]> {
    const parsed = parse(frame);
    const plain = (await decryptBody(parsed.body)).subarray(0, parsed.plaintextLen);
    const count = readU16(plain, SERIAL_PLACEHOLDER.length);
    const entries: { param: number; value: string }[] = [];
    let at = SERIAL_PLACEHOLDER.length + 4;
    for (let index = 0; index < count; index += 1) {
      const param = readU16(plain, at);
      const length = readU16(plain, at + 2);
      entries.push({
        param,
        value: new TextDecoder().decode(plain.subarray(at + 4, at + 4 + length)),
      });
      at += 4 + length;
    }
    return entries;
  }

  test("sends the allowlisted parameter and its value", async () => {
    const written: { param: number; value: string }[][] = [];
    const connection = {
      connected: true,
      async request(frame: Bytes): Promise<Bytes> {
        const parsed = parse(frame);
        if (parsed.function === FUNCTION.writeConfig) {
          written.push(await writtenEntries(frame));
        }
        return reply(responseBody([], 1));
      },
    } as unknown as Link;

    const device = await Device.open(connection, "key");
    const answer = await device.write([{ param: ACCESSORY_LIST_LAN.number, value: "CRL:" }]);

    expect(answer.status).toBe(0);
    // The first write is the handshake; the second is ours.
    expect(written.at(-1)).toEqual([{ param: ACCESSORY_LIST_LAN.number, value: "CRL:" }]);
  });

  test("refuses a parameter that is not on the allowlist, before anything is sent", async () => {
    // The factory reset stands for the whole excluded space, and it is the exclusion worth defending: it
    // clears the Wi-Fi credentials, so unlike a bad endpoint or a bad network it cannot be undone from
    // here — recovery is somebody standing at the device.
    let sent = 0;
    const connection = {
      connected: true,
      async request(): Promise<Bytes> {
        sent += 1;
        return reply(responseBody([], 1));
      },
    } as unknown as Link;

    const device = await Device.open(connection, "key");
    const before = sent;
    expect(device.write([{ param: FACTORY_RESET.number, value: "1" }])).rejects.toThrow(
      /does not write factory_reset/,
    );
    expect(sent).toBe(before);
  });

  test("refuses the whole write if any one parameter is not writable", async () => {
    const connection = {
      connected: true,
      async request(): Promise<Bytes> {
        return reply(responseBody([], 1));
      },
    } as unknown as Link;

    const device = await Device.open(connection, "key");
    // One writable parameter and one that is not: the whole frame has to go, because a partly applied
    // group is the state these groups exist to make impossible.
    expect(
      device.write([
        { param: WIFI_SSID.number, value: "somewhere" },
        { param: FACTORY_RESET.number, value: "1" },
      ]),
    ).rejects.toThrow(/factory_reset/);
  });
});
