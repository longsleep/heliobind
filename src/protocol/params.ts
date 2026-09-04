/**
 * Configuration parameters, as data.
 *
 * The numbering is the device's configuration key space, shared with its network interface. Only entries
 * marked writable may be written, and the default is not writable — the gate is structural so that adding a
 * write target is a deliberate edit rather than something forgotten.
 *
 * Meanings come from reading the vendor app, from the specification's Appendix C, and from a sweep that read
 * every parameter off a device. Anything marked `confidence: "inferred"` is a guess from context.
 *
 * ## Each parameter is a value, not a row
 *
 * Every one is its own exported constant, and the collections below are built from those constants. So a set
 * like {@link PROVISIONING} names the parameters it wants directly — no strings, no numbers, no lookup that
 * could fail at runtime. Naming a parameter that does not exist is a compile error, and renaming one updates
 * every list that mentions it.
 */

export interface Param {
  readonly number: number;
  readonly name: string;
  readonly summary: string;
  /** Whether this app is permitted to write it. */
  readonly writable: boolean;
  /** `device` where a read from the hardware confirmed it; otherwise how it was arrived at. */
  readonly confidence: "device" | "vendor-app" | "inferred";
  /**
   * What this parameter's values mean, for the few that carry a code rather than a quantity or text.
   *
   * Keyed by the value as the device sends it. A value with no entry is shown as it arrived — a code the
   * device knows and this app does not is still worth reading, so an unlisted value is never an error.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/** Shorthand for a parameter nothing may write, which is all of them for now. */
function readOnly(
  number: number,
  name: string,
  confidence: Param["confidence"],
  summary: string,
  labels?: Param["labels"],
): Param {
  return { number, name, summary, writable: false, confidence, ...(labels && { labels }) };
}

// What the device is.
export const SERIAL_NUMBER = readOnly(
  8,
  "serial_number",
  "device",
  "The device serial, also its MQTT client id.",
);
export const MODEL_ID = readOnly(20, "model_id", "device", "Model identifier.");
export const SW_VERSION = readOnly(21, "sw_version", "device", "Datalogger firmware version.");
export const HW_VERSION = readOnly(22, "hw_version", "device", "Hardware revision.");
export const PROTOCOL_VERSION = readOnly(9, "protocol_version", "device", "Wire protocol version.");
export const DEVICE_TYPE = readOnly(
  13,
  "device_type",
  "device",
  "The product. The same code the device advertises over Bluetooth, ahead of any connection.",
  { 61: "NOAH 2000", 72: "NEXA 2000", 73: "AURA/NODE 5000", 83: "VETA 2200" },
);
export const MAC_ADDRESS = readOnly(
  16,
  "mac_address",
  "device",
  "MAC-shaped, but a constant shared across the product family rather than this unit's.",
);
export const PASSWORD = readOnly(7, "password", "device", "A six-digit vendor default.");
export const BLE_HANDSHAKE_KEY = readOnly(
  54,
  "ble_handshake_key",
  "device",
  "The handshake key. Presenting it is authentication rather than configuration, and Device.open is the only thing that writes it.",
);
export const SDK_VERSION = readOnly(61, "sdk_version", "device", "ESP-IDF version of the running build.");

// The network it joined.
export const WIFI_SSID = readOnly(
  56,
  "wifi_ssid",
  "device",
  "Wi-Fi network name. Readable in clear. Writing this wrongly takes the device off the network.",
);
export const WIFI_PASSWORD = readOnly(
  57,
  "wifi_password",
  "device",
  "Wi-Fi passphrase. Returned in clear by a read.",
);
export const WIFI_SIGNAL = readOnly(76, "wifi_signal", "device", "Signal strength in dBm, sign as sent.");
export const DHCP_LEASE_0 = readOnly(
  139,
  "dhcp_lease_0",
  "device",
  "Address, mask, gateway and resolver of the joined network.",
);
export const DHCP_LEASE_1 = readOnly(
  140,
  "dhcp_lease_1",
  "device",
  "Address, mask, gateway and resolver of the joined network.",
);
export const DNS_IP = readOnly(12, "dns_ip", "device", "Resolver the device is configured with.");

// Where it reports. The three this app exists to change.
export const SERVER_ADDRESS = readOnly(
  17,
  "server_address",
  "device",
  "Hostname or address the device reports to. Reads back the vendor's broker; a write is untested.",
);
export const REMOTE_PORT = readOnly(18, "remote_port", "device", "Port the device dials.");
export const REMOTE_URL = readOnly(19, "remote_url", "device", "Hostname the device dials.");

// How it behaves once connected.
export const DATA_INTERVAL = readOnly(4, "data_interval", "device", "Telemetry cadence in seconds.");
export const DATETIME = readOnly(31, "datetime", "device", "The device clock.");
export const TIMEZONE = readOnly(
  30,
  "timezone",
  "device",
  "Reports GMT+8, and is not what the clock follows.",
);

// Actions rather than settings.
export const RESTART = readOnly(
  32,
  "restart",
  "vendor-app",
  'Write "1" to restart the datalogger. Recoverable: it reboots and reconnects by itself.',
);
export const FACTORY_RESET = readOnly(
  35,
  "factory_reset",
  "vendor-app",
  'Write "1" to reset the datalogger to factory defaults. Growatt\'s own web interface labels this "clear datalogger log"; the firmware disagrees. The serial, clock and server endpoint survive, the Wi-Fi credentials do not.',
);

// The static address configuration, which DHCP_DISABLED selects between. Unused while DHCP is on, so on
// this device all three read factory values and describe no live network.
export const STATIC_NETWORK_IP = readOnly(
  14,
  "static_network_ip",
  "vendor-app",
  "Address used when DHCP is disabled. Reads 192.168.5.1 while DHCP is on.",
);
export const STATIC_NETWORK_MASK = readOnly(
  25,
  "static_network_mask",
  "vendor-app",
  "Netmask used when DHCP is disabled.",
);
export const STATIC_NETWORK_GATEWAY = readOnly(
  26,
  "static_network_gateway",
  "vendor-app",
  "Gateway used when DHCP is disabled.",
);
export const DHCP_DISABLED = readOnly(
  71,
  "dhcp_disabled",
  "vendor-app",
  '"1" disables DHCP and uses 14/25/26; "0" leaves DHCP in charge.',
);

// Five fields shaped like a MAC, address, mask, gateway and resolver, each equal to the factory default of
// 16, 14, 25, 26 and 12. Numbered rather than named: the vendor application never reads them, and nothing
// establishes what they are for.
export const UNKNOWN_105 = readOnly(105, "unknown_105", "inferred", "A second MAC-shaped field.");
export const UNKNOWN_106 = readOnly(106, "unknown_106", "inferred", "A second address field.");
export const UNKNOWN_107 = readOnly(107, "unknown_107", "inferred", "A second mask field.");
export const UNKNOWN_108 = readOnly(108, "unknown_108", "inferred", "A second gateway field.");
export const UNKNOWN_109 = readOnly(109, "unknown_109", "inferred", "A second resolver field.");

// Named, but not understood.
export const UPDATE_URL = readOnly(
  80,
  "update_url",
  "device",
  "The last update URL the device was told to install.",
);
export const LINK_DIAGNOSTICS = readOnly(
  121,
  "link_diagnostics",
  "device",
  "A string of labelled fields: state, err_wifi, reconnect, server.",
);
export const ASSEMBLED_VALUES = readOnly(
  144,
  "assembled_values",
  "inferred",
  "A concatenation of other parameters, including the handshake key of 54.",
);
export const UNKNOWN_55 = readOnly(
  55,
  "unknown_55",
  "inferred",
  "Read by the vendor app during provisioning. Contents unknown, which is why it is a good first read.",
);
export const UNKNOWN_60 = readOnly(60, "unknown_60", "device", 'Reads back "16". Meaning unestablished.');

// The two lists of paired accessories, one per transport. Both read back as the bare prefix "DEV:" with
// nothing paired. Entries are "&"-separated, each "<mode>-<index>-<address>", and the list is edited by
// writing a command prefix: "ADD:", "DEL:" or "CRL:". A delete marks an entry rather than removing it.
export const ACCESSORY_LIST_LAN = readOnly(
  122,
  "accessory_list_lan",
  "device",
  "Accessories the device reaches over the network, such as an energy meter it polls by address.",
);
export const ACCESSORY_LIST_RF = readOnly(
  102,
  "accessory_list_rf",
  "inferred",
  "Accessories the device reaches over its sub-GHz radio, such as a GroPlug. Same syntax as 122, never exercised.",
);

/**
 * Parameters 124 to 138: fifteen slots of connection-event records.
 *
 * A ring buffer rather than a list — a sweep found the two highest slots holding the *oldest* entries — so
 * the slot number is a position and not an age. Generated because fifteen entries differing only in a number
 * is fifteen chances to mistype one, and nothing needs to name an individual slot.
 */
export const CONNECTION_EVENTS: readonly Param[] = Array.from({ length: 15 }, (_, index) =>
  readOnly(
    124 + index,
    `connection_event_${String(index).padStart(2, "0")}`,
    "device",
    "One timestamped connection record: time, network, endpoint. A slot in a ring buffer.",
  ),
);

/** Every parameter whose meaning is established. */
export const PARAMS: readonly Param[] = [
  DATA_INTERVAL,
  PASSWORD,
  SERIAL_NUMBER,
  PROTOCOL_VERSION,
  DNS_IP,
  DEVICE_TYPE,
  STATIC_NETWORK_IP,
  MAC_ADDRESS,
  SERVER_ADDRESS,
  REMOTE_PORT,
  REMOTE_URL,
  MODEL_ID,
  SW_VERSION,
  HW_VERSION,
  STATIC_NETWORK_MASK,
  STATIC_NETWORK_GATEWAY,
  TIMEZONE,
  DATETIME,
  RESTART,
  FACTORY_RESET,
  BLE_HANDSHAKE_KEY,
  UNKNOWN_55,
  WIFI_SSID,
  WIFI_PASSWORD,
  UNKNOWN_60,
  SDK_VERSION,
  DHCP_DISABLED,
  WIFI_SIGNAL,
  UPDATE_URL,
  UNKNOWN_105,
  UNKNOWN_106,
  UNKNOWN_107,
  UNKNOWN_108,
  UNKNOWN_109,
  ACCESSORY_LIST_RF,
  ACCESSORY_LIST_LAN,
  LINK_DIAGNOSTICS,
  ...CONNECTION_EVENTS,
  DHCP_LEASE_0,
  DHCP_LEASE_1,
  ASSEMBLED_VALUES,
];

/**
 * What matters when joining a device to a network and pointing it at a server.
 *
 * The set a person needs when setting up a new device, or when working out why an existing one is not
 * reaching the server it should be — which is the job this app exists to do. Everything here says what the
 * device is, where it sits on the network it joined, which server it reports to, or whether the radio link
 * is good enough where it was installed.
 *
 * Deliberately not everything with a name. The ring buffer, the duplicate network fields and the assembled
 * blob are worth reading when investigating the protocol and are noise when provisioning; they stay
 * available through the full read.
 */
export const PROVISIONING: readonly Param[] = [
  SERIAL_NUMBER,
  MODEL_ID,
  SW_VERSION,
  HW_VERSION,
  PROTOCOL_VERSION,
  BLE_HANDSHAKE_KEY,
  WIFI_SSID,
  WIFI_PASSWORD,
  WIFI_SIGNAL,
  DHCP_DISABLED,
  DHCP_LEASE_0,
  DHCP_LEASE_1,
  DNS_IP,
  SERVER_ADDRESS,
  REMOTE_PORT,
  REMOTE_URL,
  DATA_INTERVAL,
  DATETIME,
];

/**
 * The highest parameter that exists, making the space `0..=PARAM_SPACE_LAST`.
 *
 * 146 parameters. The figure comes from a compile-time loop bound in the datalogger firmware and was
 * confirmed by asking a device for every number in turn: it answered on 0–145 and on nothing above. Two
 * unrelated methods and two firmware releases agreeing, so it is a property of the protocol rather than of
 * one build.
 *
 * What it buys is that reading everything **terminates**. {@link PARAMS} names the ones whose meaning is
 * established; this is the size of the space they sit in.
 */
export const PARAM_SPACE_LAST = 145;

/** Every parameter number the space contains, in order. */
export function everyParam(): number[] {
  return Array.from({ length: PARAM_SPACE_LAST + 1 }, (_, number) => number);
}

/** The numbers behind a set of parameters, for the read path, which speaks in numbers. */
export function numbersOf(params: readonly Param[]): number[] {
  return params.map((param) => param.number);
}

/**
 * Split parameters into request-sized groups.
 *
 * A read request carries a count and that many numbers, so several parameters fit in one exchange. Sizes up
 * to 16 answer completely over Bluetooth and 8 does over the network; where the ceiling actually is remains
 * unmeasured, which is why the size is an argument here rather than a constant in the read path.
 */
export function batches(params: readonly number[], size: number): number[][] {
  const step = Math.max(1, Math.floor(size));
  const out: number[][] = [];
  for (let at = 0; at < params.length; at += step) {
    out.push(params.slice(at, at + step));
  }
  return out;
}

/**
 * Every parameter in the space as something offerable, named where a name is established.
 *
 * {@link PARAMS} is the named subset and is what a menu of *meanings* would list, but it is the wrong list
 * for choosing what to read: two thirds of the space has no established meaning, and those are the ones
 * worth asking about. Offering only the named ones makes the unnamed unreachable — including 145, the one
 * register known to behave differently from the rest.
 */
export function everyChoice(): { number: number; name: string; summary: string }[] {
  return everyParam().map((number) => ({
    number,
    name: describe(number),
    summary: lookup(number)?.summary ?? "No established meaning. Reading it is how that changes.",
  }));
}

const BY_NUMBER = new Map(PARAMS.map((param) => [param.number, param]));

export function lookup(number: number): Param | undefined {
  return BY_NUMBER.get(number);
}

/**
 * Name a parameter for display.
 *
 * A parameter with no established meaning reads as `unknown_<number>`, which is what the specification's
 * Appendix C calls them and what the bridge publishes to Home Assistant. One address space, one vocabulary:
 * a reading taken over Bluetooth should be comparable with the same reading taken over the network without
 * anyone having to translate.
 */
export function describe(number: number): string {
  return lookup(number)?.name ?? `unknown_${number}`;
}

/**
 * What a value means, for a parameter that carries a code.
 *
 * `undefined` for everything else, which is all but a handful: a quantity means itself, and a code this
 * app has not been taught is shown as the device sent it rather than guessed at. Surrounding space is
 * ignored, since a value's shape is the device's choice and not promised.
 */
export function label(number: number, value: string): string | undefined {
  return lookup(number)?.labels?.[value.trim()];
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
