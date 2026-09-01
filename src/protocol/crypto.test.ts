import { beforeAll, describe, expect, test } from "bun:test";
import { useTestCipher } from "./cipher.fixture.ts";
import { CryptoError, decryptBody, encryptBody, internals, key } from "./crypto.ts";
import { type Bytes, fromHex, toHex } from "./frame.ts";

const { BLOCK, iv: ivBytes, rawEncryptBlock } = internals;

beforeAll(useTestCipher);

const IV = ivBytes();

describe("the padding synthesis", () => {
  test("zero-IV CBC over one block is raw block encryption", async () => {
    // If this identity fails, decryptBody's whole approach is invalid, so assert it directly:
    // encrypting one block under a zero IV must equal the first block of encrypting two blocks
    // whose first is the same, because CBC XORs only with the IV for block zero.
    const block = fromHex("00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f");
    const single = (await rawEncryptBlock(await key(), block)).subarray(0, BLOCK);

    const two = new Uint8Array(BLOCK * 2);
    two.set(block, 0);
    two.set(block, BLOCK);
    const both = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CBC", iv: internals.ZERO_IV }, await key(), two),
    );
    expect(toHex(both.subarray(0, BLOCK))).toBe(toHex(single));
  });

  test("decrypts a body carrying no PKCS7 padding", async () => {
    // Build ciphertext the way the device does: block-aligned plaintext, encrypted with no padding
    // of its own. Web Crypto cannot produce that directly, so assemble it a block at a time.
    const plaintext = fromHex(
      "48 65 6c 6c 6f 20 4e 45 58 41 21 00 00 00 00 00" + "01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10",
    );
    const ciphertext = await encryptNoPadding(plaintext);

    // Web Crypto refuses it outright, which is the problem decryptBody exists to solve.
    await expect(
      crypto.subtle.decrypt({ name: "AES-CBC", iv: IV }, await key(), ciphertext),
    ).rejects.toThrow();

    expect(toHex(await decryptBody(ciphertext))).toBe(toHex(plaintext));
  });

  test("round-trips a padded body, so both directions agree", async () => {
    // What the app actually sends: encryptBody pads, so the ciphertext is one block longer and the
    // trailing padding shows up as plaintext for decryptBody. The frame's length field trims it.
    const body = new TextEncoder().encode("0000000000");
    const ciphertext = await encryptBody(body);
    const recovered = await decryptBody(ciphertext);
    expect(toHex(recovered.subarray(0, body.length))).toBe(toHex(body));
  });

  test("refuses ciphertext that is not a whole number of blocks", async () => {
    await expect(decryptBody(new Uint8Array(17))).rejects.toThrow(CryptoError);
    await expect(decryptBody(new Uint8Array(0))).rejects.toThrow(CryptoError);
  });
});

describe("encryptBody", () => {
  test("pads to the next block boundary", async () => {
    expect((await encryptBody(new Uint8Array(1))).length).toBe(BLOCK);
    expect((await encryptBody(new Uint8Array(15))).length).toBe(BLOCK);
    // A whole block gains an entire block of padding, which is how PKCS7 stays unambiguous.
    expect((await encryptBody(new Uint8Array(16))).length).toBe(BLOCK * 2);
  });

  test("is deterministic, the IV being fixed", async () => {
    const once = await encryptBody(new TextEncoder().encode("same input"));
    const twice = await encryptBody(new TextEncoder().encode("same input"));
    expect(toHex(once)).toBe(toHex(twice));
  });
});

/**
 * Encrypt without padding, to stand in for the device.
 *
 * Web Crypto always pads, so do CBC by hand: XOR each block with the previous ciphertext block and
 * encrypt it raw. Only used by the tests — the app never needs to produce unpadded ciphertext.
 */
async function encryptNoPadding(plaintext: Bytes): Promise<Bytes> {
  if (plaintext.length % BLOCK !== 0) throw new Error("test plaintext must be block aligned");
  const k = await key();
  const out = new Uint8Array(plaintext.length);
  let previous = IV;
  for (let at = 0; at < plaintext.length; at += BLOCK) {
    const block = new Uint8Array(BLOCK);
    for (let i = 0; i < BLOCK; i += 1) block[i] = plaintext[at + i]! ^ previous[i]!;
    const encrypted = (await rawEncryptBlock(k, block)).subarray(0, BLOCK);
    out.set(encrypted, at);
    previous = encrypted;
  }
  return out;
}
