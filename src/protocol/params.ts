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
  /**
   * The two values this parameter takes, for the ones that are a flag rather than a field.
   *
   * Present means it is offered as a checkbox. The polarity lives here, beside the parameter, rather than
   * in the interface: `on` is what a ticked box writes and `off` what an empty one does, so a parameter
   * whose name is a negative — `dhcp_disabled` — cannot pick up an inversion on its way to the screen.
   */
  readonly toggle?: {
    readonly on: string;
    readonly off: string;
    /** What ticking the box does, in the words of somebody deciding whether to. */
    readonly label: string;
  };
}

/** Shorthand for a parameter nothing may write, which is most of them. */
function readOnly(
  number: number,
  name: string,
  confidence: Param["confidence"],
  summary: string,
  labels?: Param["labels"],
): Param {
  return { number, name, summary, writable: false, confidence, ...(labels && { labels }) };
}

/**
 * Shorthand for a parameter this app may write.
 *
 * Deliberately rare. A write over this transport reaches the same configuration space that decides which
 * server the device dials and which network it joins, and the device has no undo — so a parameter is added
 * here only once writing it has been shown to be recoverable, and each addition should say how.
 */
function writable(
  number: number,
  name: string,
  confidence: Param["confidence"],
  summary: string,
  labels?: Param["labels"],
  toggle?: Param["toggle"],
): Param {
  return {
    number,
    name,
    summary,
    writable: true,
    confidence,
    ...(labels && { labels }),
    ...(toggle && { toggle }),
  };
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
export const WIFI_SSID = writable(
  56,
  "wifi_ssid",
  "device",
  "Wi-Fi network name. Readable in clear. Written with the passphrase in one frame, never alone.",
);
export const WIFI_PASSWORD = writable(
  57,
  "wifi_password",
  "device",
  "Wi-Fi passphrase. Returned in clear by a read, and written with the network name in one frame.",
);
export const WIFI_SIGNAL = readOnly(76, "wifi_signal", "device", "Signal strength in dBm, sign as sent.");

// The two links the datalogger reports on itself, and what a provisioning attempt is confirmed by. Both
// meanings come from the vendor app's own polling loop and agree with a device connected to a local bridge.
export const ROUTER_STATUS = readOnly(
  55,
  "router_status",
  "vendor-app",
  'The link to the router. "0" means joined; anything else is a failure code.',
  { "0": "joined" },
);
export const SERVER_STATUS = readOnly(
  60,
  "server_status",
  "vendor-app",
  'The link to the server. "3", "4" and "16" mean connected.',
  { "3": "connected", "4": "connected", "16": "connected" },
);
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
export const DNS_IP = writable(
  12,
  "dns_ip",
  "device",
  "Resolver the device is configured with. The vendor app writes it from the cloud path only; over Bluetooth it never does, though the device takes it either way.",
);

// Where it reports. The three this app exists to change.
export const SERVER_ADDRESS = writable(
  17,
  "server_address",
  "device",
  "Where the device reports. The same setting as 19 — the firmware hands both to one endpoint setter, so whichever is written last wins.",
);
export const REMOTE_PORT = writable(
  18,
  "remote_port",
  "device",
  "Port the device dials. Its own handler, so it takes effect independently of the host.",
);
export const REMOTE_URL = writable(
  19,
  "remote_url",
  "device",
  "The same setting as 17, not a second hostname field. The vendor app blanks whichever it is not using; copying that leaves no stale value behind.",
);

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
export const RESTART = writable(
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
export const STATIC_NETWORK_IP = writable(
  14,
  "static_network_ip",
  "vendor-app",
  "Address used when DHCP is disabled. Reads 192.168.5.1 while DHCP is on.",
);
export const STATIC_NETWORK_MASK = writable(
  25,
  "static_network_mask",
  "vendor-app",
  "Netmask used when DHCP is disabled.",
);
export const STATIC_NETWORK_GATEWAY = writable(
  26,
  "static_network_gateway",
  "vendor-app",
  "Gateway used when DHCP is disabled.",
);
export const DHCP_DISABLED = writable(
  71,
  "dhcp_disabled",
  "vendor-app",
  '"1" disables DHCP and uses 14/25/26; "0" leaves DHCP in charge. Written first in its group, ahead of the addresses that only matter once it is set.',
  { "0": "DHCP", "1": "static" },
  { on: "1", off: "0", label: "use the static address below instead of DHCP" },
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
// The two lists of paired accessories, one per transport. Both read back as the bare prefix "DEV:" with
// nothing paired. Entries are "&"-separated, each "<mode>-<index>-<address>", and the list is edited by
// writing a command prefix: "ADD:", "DEL:" or "CRL:". A delete marks an entry rather than removing it.
/**
 * The one parameter this app writes, and the reason it is the one.
 *
 * Writing it changes nothing that can strand the device: the list lives in RAM, so a restart clears it
 * whatever state it was left in, and an empty list is the normal state for a device with no accessories.
 * It is therefore the cheapest possible proof that a write other than the handshake reaches the
 * configuration space — read it, write it, read it again.
 *
 * Three commands, and only one of them removes what this app can add:
 *
 * - `ADD:<type>-<mode>-<address>,<name>` creates an entry. Mode 1 is an accessory at a known address.
 * - `DEL:` with the same fields **tombstones** it — the entry stays in the list reading state `5` rather
 *   than disappearing, and only a restart drops it.
 * - `CRL:<type>-7-<payload>` clears **mode 7 only**, the entries a device found by mDNS. It is accepted
 *   against a mode-1 entry and does nothing to it, which reads as a write that failed silently and is not.
 */
export const ACCESSORY_LIST_LAN = writable(
  122,
  "accessory_list_lan",
  "device",
  'Accessories the device reaches over the network, such as an energy meter it polls by address. Writable: "ADD:<type>-1-<address>,<name>" adds one and "DEL:" with the same fields tombstones it as state 5. The list is RAM-only, so a restart clears it.',
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
  ROUTER_STATUS,
  WIFI_SSID,
  WIFI_PASSWORD,
  SERVER_STATUS,
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
 * Every version the configuration space carries is here — the datalogger's firmware, the hardware
 * revision, the SDK the build was made with, and the wire protocol — since "which versions is it running"
 * is the question a support thread opens with. The vendor's six-field release string is **not** among
 * them: four of its fields are component versions held in input registers, which this transport reaches
 * through the Modbus passthrough rather than through a parameter — so the firmware version reported here is
 * the datalogger's own field of that string rather than the whole of it. `Device.componentVersions` asks
 * for the other four.
 *
 * Deliberately not everything with a name. The ring buffer, the duplicate network fields and the assembled
 * blob are worth reading when investigating the protocol and are noise when provisioning; they stay
 * available through the full read.
 */
export const PROVISIONING: readonly Param[] = [
  SERIAL_NUMBER,
  DEVICE_TYPE,
  MODEL_ID,
  SW_VERSION,
  HW_VERSION,
  SDK_VERSION,
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
 * The permitted set is a reviewable list rather than a condition somewhere in a handler: adding a
 * parameter to it is a visible edit to {@link WRITABLE}, and {@link Device.write} refuses anything absent
 * from it before a frame is built.
 */
export function isWritable(number: number): boolean {
  return lookup(number)?.writable ?? false;
}

/**
 * Every parameter this app will write, in the order a control offers them.
 *
 * The list exists so that the answer to "what can this app change?" is a list somebody can read, rather
 * than a search through the table for a flag.
 */
export const WRITABLE: readonly Param[] = PARAMS.filter((param) => param.writable);

/**
 * A set of parameters that belong in one write.
 *
 * The vendor's own client never writes these one at a time, and the reason is worth keeping: a network
 * name without its passphrase, or a static address without the flag that selects it, is a device that
 * cannot be reached. One frame carries the whole group or none of it.
 *
 * The order is the vendor's order too — the DHCP flag ahead of the addresses it selects between, the
 * hostname ahead of the address that shares its setting — since the device applies entries as they arrive.
 */
export interface Group {
  /** Stable identifier, used in the interface. */
  readonly key: string;
  /** What to call it. */
  readonly title: string;
  /** What it does, and what it costs to get wrong. */
  readonly summary: string;
  /** The parameters, in the order they go into the frame. */
  readonly params: readonly Param[];
  /** Whether getting this wrong can leave the device unreachable over the network. */
  readonly disruptive: boolean;
  /**
   * Whether the datalogger has to restart before a write here does anything.
   *
   * True for everything the device reads once at start-up, which is all of the network configuration: the
   * value is stored immediately and ignored until the next boot. A group where it is false takes effect as
   * it is written, and offering to restart for it would be theatre.
   */
  readonly restartToApply: boolean;
}

export const WIFI_GROUP: Group = {
  key: "wifi",
  title: "Wi-Fi network",
  summary:
    "The network the device joins. Both fields go in one frame: a name without its passphrase is a device on no network. Recovery is another Bluetooth session — this one.",
  params: [WIFI_SSID, WIFI_PASSWORD],
  disruptive: true,
  restartToApply: true,
};

export const ADDRESSING_GROUP: Group = {
  key: "addressing",
  title: "Addressing",
  summary:
    'DHCP or a static address. The flag leads, then the address, gateway and mask it selects between. Setting the flag to "1" without an address that works on this network is the most effective way to lose the device.',
  params: [DHCP_DISABLED, STATIC_NETWORK_IP, STATIC_NETWORK_GATEWAY, STATIC_NETWORK_MASK, DNS_IP],
  disruptive: true,
  restartToApply: true,
};

export const SERVER_GROUP: Group = {
  key: "server",
  title: "Server",
  summary:
    "Where the device reports. 17 and 19 are one setting, so both are written — the vendor's client blanks whichever it is not using, which leaves no stale value for the next writer to inherit.",
  params: [REMOTE_URL, SERVER_ADDRESS, REMOTE_PORT],
  disruptive: true,
  restartToApply: true,
};

export const GROUPS: readonly Group[] = [WIFI_GROUP, ADDRESSING_GROUP, SERVER_GROUP];

/**
 * Writable settings that no group and no button already offers, and so need a field of their own.
 *
 * Derived rather than listed. A setting that joins a group leaves here by itself, which is what stops the
 * same value being offered in two places that can disagree about what it currently holds — the single field
 * writes one parameter and knows nothing of the frame its neighbours belong in.
 *
 * The accessory list is all that is left: the network configuration is grouped, and the restart is a button
 * rather than a value to type.
 */
export const WRITABLE_ALONE: readonly Param[] = WRITABLE.filter(
  (param) => param !== RESTART && !GROUPS.some((group) => group.params.includes(param)),
);

/**
 * What the device says about its own two links.
 *
 * Read after a change rather than before: the router status turns to `"0"` once it has joined, and the
 * server status to `"3"`, `"4"` or `"16"` once it has reported in. Together they are the only confirmation
 * a client gets that a change worked, short of the device appearing somewhere else.
 */
export const LINK_STATUS: readonly Param[] = [ROUTER_STATUS, SERVER_STATUS];
