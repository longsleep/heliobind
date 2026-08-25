/**
 * Configuration parameters, as data.
 *
 * The numbering is the device's configuration key space, shared with its network interface. Only entries
 * marked writable may be written, and the default is not writable — the gate is structural so that adding a
 * write target is a deliberate edit rather than something forgotten.
 *
 * Meanings come from reading the vendor app, not from exchanging bytes with a device. Anything marked
 * `confidence: "inferred"` is a guess from context.
 */

/**
 * The parameter carrying the handshake key.
 *
 * Not in the table below and never writable through the ordinary path: presenting it is authentication, not
 * configuration, and {@link Device.open} is the only thing that writes it.
 */
export const KEY_PARAM = 54;

export interface Param {
  readonly number: number;
  readonly name: string;
  readonly summary: string;
  /** Whether this app is permitted to write it. */
  readonly writable: boolean;
  /** `device` where a read from the hardware confirmed it; otherwise how it was arrived at. */
  readonly confidence: "device" | "vendor-app" | "inferred";
}

export const PARAMS: readonly Param[] = [
  {
    number: 17,
    name: "server_address",
    summary:
      "Hostname or address the device reports to. Reads back the vendor's broker; a write is untested.",
    writable: false,
    confidence: "device",
  },
  {
    number: 32,
    name: "restart",
    summary: 'Write "1" to restart the datalogger. Recoverable: it reboots and reconnects by itself.',
    writable: false,
    confidence: "vendor-app",
  },
  {
    number: 54,
    name: "bind_key",
    summary: "The handshake key. Presented on connect; see KEY_PARAM.",
    writable: false,
    confidence: "device",
  },
  {
    number: 55,
    name: "unknown_55",
    summary:
      "Read by the vendor app during provisioning. Contents unknown, which is why it is a good first read.",
    writable: false,
    confidence: "inferred",
  },
  {
    number: 56,
    name: "wifi_ssid",
    summary: "Wi-Fi network name. Readable in clear. Writing this wrongly takes the device off the network.",
    writable: false,
    confidence: "device",
  },
  {
    number: 57,
    name: "wifi_password",
    summary: "Wi-Fi passphrase. Returned in clear by a read.",
    writable: false,
    confidence: "device",
  },
  {
    number: 60,
    name: "unknown_60",
    summary: 'Reads back "16". Meaning unestablished.',
    writable: false,
    confidence: "device",
  },
];

const BY_NUMBER = new Map(PARAMS.map((param) => [param.number, param]));

export function lookup(number: number): Param | undefined {
  return BY_NUMBER.get(number);
}

/** Name a parameter for display, falling back to its number when unrecognised. */
export function describe(number: number): string {
  return lookup(number)?.name ?? `parameter ${number}`;
}

/**
 * Whether this app may write a parameter.
 *
 * There is no write path in the code yet. This exists so that when there is, the permitted set is a
 * reviewable list rather than a condition somewhere in a handler.
 */
export function isWritable(number: number): boolean {
  return lookup(number)?.writable ?? false;
}
