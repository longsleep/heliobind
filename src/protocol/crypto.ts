/**
 * AES-128-CBC for the Bluetooth body, in both directions.
 *
 * The key and IV are fixed ASCII strings taken from the vendor app. They are the same on every device, so
 * they authenticate nothing and protect nothing — treat this as obfuscation with a respectable algorithm,
 * not as security. Anyone in Bluetooth range can speak the protocol.
 *
 * The awkward part is a padding asymmetry. The vendor encrypts with PKCS5 (identical to PKCS7 at a 16-octet
 * block) and decrypts with *no* padding, trimming the plaintext instead using the length field in the frame
 * header. Web Crypto has no no-padding mode: `decrypt` insists on a valid PKCS7 tail and throws without one.
 * {@link decryptBody} works around that — see the comment there.
 */

import type { Bytes } from "./frame.ts";

const KEY_TEXT = "0123456789abcdef";
const IV_TEXT = "fedcba9876543210";
const BLOCK = 16;

function asciiBytes(text: string): Bytes {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

const IV = asciiBytes(IV_TEXT);
const ZERO_IV = new Uint8Array(BLOCK);

export class CryptoError extends Error {}

let cached: Promise<CryptoKey> | null = null;

/** The one key, imported once. */
export function key(): Promise<CryptoKey> {
  cached ??= crypto.subtle.importKey("raw", asciiBytes(KEY_TEXT), { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return cached;
}

/**
 * Encrypt a body for transmission.
 *
 * Web Crypto applies PKCS7, which is what the vendor's PKCS5 means at this block size, so this needs no
 * special handling.
 */
export async function encryptBody(plaintext: Bytes): Promise<Bytes> {
  const out = await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV }, await key(), plaintext);
  return new Uint8Array(out);
}

/**
 * Decrypt a received body, which carries no PKCS7 padding.
 *
 * Web Crypto will not decrypt without padding, so synthesise a padding block it will accept and strip.
 * The trick rests on one observation: **AES-CBC with an all-zero IV over a single block is ECB for that
 * block**, because the first block is XORed with the IV before encryption. That gives raw block encryption
 * without an ECB primitive.
 *
 * CBC decryption gives `P[n] = D(C[n]) XOR C[n-1]`. Appending a block `Cx` therefore yields a final
 * plaintext block of `D(Cx) XOR C[last]`. Choosing `Cx = E(pad XOR C[last])` makes that come out as exactly
 * `pad` — a full, valid PKCS7 block — which the browser then removes, leaving the true plaintext of the
 * original ciphertext untouched.
 *
 * If a future browser or a corrected reading of the vendor code shows the device pads properly after all,
 * delete this and call `decrypt` directly. It exists to solve a problem, not because it is clever.
 */
export async function decryptBody(ciphertext: Bytes): Promise<Bytes> {
  if (ciphertext.length === 0 || ciphertext.length % BLOCK !== 0) {
    throw new CryptoError(`ciphertext is ${ciphertext.length} octets, not a whole number of blocks`);
  }
  const k = await key();
  const lastBlock = ciphertext.subarray(ciphertext.length - BLOCK);

  const pad = new Uint8Array(BLOCK).fill(BLOCK);
  const target = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i += 1) target[i] = pad[i]! ^ lastBlock[i]!;

  const synthesised = (await rawEncryptBlock(k, target)).subarray(0, BLOCK);

  const withPadding = new Uint8Array(ciphertext.length + BLOCK);
  withPadding.set(ciphertext, 0);
  withPadding.set(synthesised, ciphertext.length);

  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: IV }, k, withPadding);
  return new Uint8Array(plain);
}

/**
 * Raw single-block AES encryption, via CBC with a zero IV.
 *
 * Web Crypto appends a padding block of its own, so the result is two blocks and only the first is wanted.
 */
async function rawEncryptBlock(k: CryptoKey, block: Bytes): Promise<Bytes> {
  if (block.length !== BLOCK) throw new CryptoError("raw encryption takes exactly one block");
  const out = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, k, block);
  return new Uint8Array(out);
}

/** Exported for the tests, which need to prove the synthesis against a known plaintext. */
export const internals = { rawEncryptBlock, BLOCK, IV, ZERO_IV };
