# Heliobind

Find and read a Growatt balcony battery over Bluetooth, from a browser. Eventually: join it to a Wi-Fi
network and point it at a server of your choosing, without the vendor app.

Named for what it does: the datalogger calls its handshake credential the _bind key_, and binding a device
is the vendor's own word for the ritual this replaces. It is the Bluetooth half of
[heliobridge](https://github.com/longsleep/heliobridge), which serves the same devices over the network.

**A NEXA 2000 is what it is developed against, not what it is limited to.** The Bluetooth interface belongs
to the datalogger, which is shared across the family — NOAH 2000, NEXA 2000, AURA 5000 and VETA 2000 — so
the configuration space, the framing and the cipher are common to all of them.

**It reads everything and changes three things.** Discovery, connection and a read of any configuration
parameter; and writes for the settings that decide whether the device can be reached at all — the Wi-Fi
network it joins, whether it is addressed by DHCP or statically, and where it reports. Everything else is
read-only, and the permitted set is a list in `src/protocol/params.ts` rather than a condition in a handler.

**Each of those goes to the device as one frame**, in the order the vendor's own client uses, carrying only
the fields that differ from what was just read. A network name without its passphrase, or a static address
without the flag that selects it, is a device that cannot be reached — so the group is the unit, not the
parameter. Nothing takes effect until the datalogger restarts, which is a separate button, so a change can
be staged and read back before it is committed.

> ⚠ **Bluetooth is the way back from all of it**, which is why these writes are offered here and not
> elsewhere. It is also the only way back: recovering a device that was pointed at the wrong network means
> standing next to it with this page open.

> **A personal weekend project, built with heavy AI assistance.** It runs against exactly one device — the
> author's — and it is written to be honest about what has actually been observed rather than to be a
> product. Treat it accordingly. It is not affiliated with or endorsed by Growatt.

## Requirements

**Chrome or Edge**, on Android, Windows, macOS or ChromeOS. Desktop works if the machine has a Bluetooth
adapter and is close enough to the device — a few metres of open air is not enough.

**On Linux, Web Bluetooth ships disabled.** Chromium calls Linux partially implemented and unsupported, so
`navigator.bluetooth` does not exist until you enable
`chrome://flags/#enable-experimental-web-platform-features` and restart. BlueZ 5.41 or newer is also needed.

**No browser on iOS** supports it, whatever it is called; they are all Safari underneath. The page says so
rather than failing at the first tap.

Served over HTTPS, or from `localhost`. Web Bluetooth requires a secure context.

**Three constants, which this project does not distribute.** See below.

## The constants this app does not ship

The Bluetooth interface needs three values that are not in this repository: a cipher key, a cipher IV, and
the handshake key a device is greeted with. Enter them under **Protocol constants** in the app; they are
kept in the browser's own storage and typed once. Until all three are present, nothing connects.

They are held back deliberately. The values are the same on every device of this family, the device accepts
them from anyone in radio range, and nothing on the vendor's side limits what may then be read or written —
so they open a neighbour's battery exactly as readily as your own.

All three are recoverable from the vendor's Android application by anyone willing to decompile it. That is
the point: it is a small effort for someone doing protocol work on hardware they own, and one this project
declines to remove for everyone else.

> Anything you enter is stored in that browser profile and never leaves the device — the app makes no
> network requests at all, which its content security policy enforces rather than promises. On a shared
> machine, use **Forget these**.

## Running it

The quickest way, if you have [Bun](https://bun.com):

```sh
bunx heliobind
```

That serves the built app on `http://127.0.0.1:8787` and prints the address. Open it in Chrome. `--port`
and `--host` are accepted.

It has to be `bunx` rather than `npx`: the server is a TypeScript file run by Bun, and Node will not
execute it.

Localhost is a secure context, which is why this needs no certificate. It is also why it is the desktop
path — a phone cannot reach your laptop's localhost. For that, see the reverse proxy below.

### From a checkout

```sh
bun install --frozen-lockfile
bun run dev        # http://localhost:3000
```

```sh
bun run check      # lint, types, tests
bun run build      # static site into dist/
bun run build:local  # the same, with the protocol constants compiled in
```

`build` never compiles the constants in, even with `.env.local` present, and fails if one reaches the
output by any other route. `build:local` is the opt-in for a copy you install on your own phone — do not
publish what it produces.

### Testing on a phone

Bluetooth needs a secure context, so the phone has to reach the page over HTTPS. This app does not
terminate TLS; put a reverse proxy in front that does.

The packaged server is the easier target. Leave it on loopback and let the proxy reach it there:

```sh
bunx heliobind                     # http://127.0.0.1:8787
```

```caddy
# Caddyfile — Caddy obtains the certificate itself
heliobind.example.org {
    reverse_proxy 127.0.0.1:8787
}
```

or with nginx, inside a server block that already has a certificate:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

If the proxy runs on a different machine, bind wider — `bunx heliobind --host 0.0.0.0` — and firewall the
port. Do not open the plain HTTP port to the phone directly: without TLS the browser will not treat it as
a secure context, and Bluetooth stays unavailable however the page looks.

**No host allowlist to fight.** The packaged server answers whatever `Host` the proxy sends, so a DNS name
works with nothing to configure. The development server is stricter — see below — which is the main reason
to prefer `bunx heliobind` for this.

To proxy the development server instead, while editing code:

```sh
bun run dev --host=0.0.0.0
```

Arguments after the script name are forwarded straight to the server, so `--host` and `--port` work there.
`PORT` on its own also comes from `.env.local`, which Bun reads without being asked — copy `.env.example`.
A host cannot come from there: `.env` files reach the runtime but not the shell that expands
`package.json` scripts.

### Getting past "Blocked: Host header does not match the dev server"

The server checks the `Host` header against its own bind address, and there is no setting to extend the
list. It accepts `localhost`, any bare IPv4 literal, a bracketed IPv6 literal, or an exact match for the
host it was started with — so a proxy forwarding a DNS name is refused. Three ways out, cheapest first:

1. **Reach the proxy by IP.** Nothing to configure; a bare IPv4 `Host` is always accepted.
2. **Start the server under the name the proxy sends**, which works when that name resolves to an address
   on this machine:

   ```sh
   bun run dev --host=my-host.example
   ```

   `--host` sets the bind address as well as the accepted name, so a name pointing elsewhere cannot be
   bound.

3. **Have the proxy rewrite the header**, e.g. `proxy_set_header Host localhost;` in nginx.

The server also validates `Origin` on the hot-reload socket, so hot reload may not survive a proxy even
once the page loads — reload by hand. To exercise the real bundle and the content security policy, which
the development server does not apply, run `bun run build` and serve `dist/` with any static server.

Everything runs on Bun 1.4.0, pinned. There are no runtime dependencies; the four development ones are the
type checker, the linter, and two sets of type definitions.

## What it does

1. Filters the chooser on the vendor's service **and** its manufacturer-data marker, so it offers this
   family of device and not other hardware. The service alone is Espressif's example UUID, which unrelated
   ESP32 projects advertise too; the marker is the `G:` that leads the vendor's manufacturer data. Any
   model of the family is still offered — the device-type code that follows is deliberately not matched.
2. Connects and subscribes to the command characteristic.
3. Sends a configuration read and decodes the reply.

The reply is shown as raw octets and as text, because how a reply body is laid out is not yet established —
raw is more honest than a guess at structure.

**Parameters per request** sets how many parameters one request names. Sizes up to 16 answer completely on
the device this was developed against, so a whole-space read is a handful of requests rather than 146. One
at a time is what the vendor app sends and is the thing to fall back to on a device that answers a batch
short — which shows up as a fast read with values missing rather than as an error, so every read reports how
many requests it sent.

The parameter menu offers the whole space, named where a name is established and `unknown_<n>` where not.
The unnamed ones are most of it, and reading them is how that changes.

A parameter that carries a code is shown as the value with its meaning after it — `72 (NEXA 2000)` for the
device type — so a reading stays comparable with the same reading taken any other way. A code with no
established meaning is shown as it arrived.

## Safety

**Nothing here writes to the device.** That is deliberate rather than incidental: the parameters that carry
Wi-Fi credentials are known, and writing them wrongly takes the device off the network. Recovery means
provisioning it again, and until this app can do that reliably, the recovery path is the vendor app. Reads
prove the framing, the cipher and the checksum end to end while being unable to change anything, so reads
come first.

When writes do arrive they will be gated, will name the parameter and value before sending, and will start
with the server address rather than the credentials — a wrong server address is recoverable over Bluetooth,
a wrong network name is not.

## Privacy

The page makes no network requests. Its content security policy sets `connect-src 'none'`, so that is
enforced by the browser rather than promised by the author. Nothing is stored, nothing is logged, and no
analytics are present. When the app eventually asks for a Wi-Fi passphrase, that passphrase goes to the
device over Bluetooth and nowhere else.

The dependency tree is kept at nearly nothing for the same reason: a page that handles a passphrase should
be small enough for one person to read in a sitting.

### One gap, and it is the host's

The policy is delivered in a `<meta>` tag, because **GitHub Pages cannot serve custom response headers** —
there is no `_headers` file, no `.htaccess`, no configuration of any kind. A meta tag carries most of CSP
but not all of it: `frame-ancestors`, `report-uri` and `sandbox` are ignored there by specification. So on
Pages this page **cannot stop itself being framed**, and `X-Frame-Options` is a header too and equally
unavailable.

The policy therefore omits `frame-ancestors` rather than listing a directive that does nothing. If framing
matters for your deployment, serve the built output from somewhere that can set headers — a static host
with a `_headers` file, or a CDN in front of Pages — and set the whole policy there as a real header,
adding `frame-ancestors 'none'`.

## Layout

```
src/protocol/   pure functions over bytes — framing, checksum, cipher, parameters
src/transport/  Web Bluetooth: discovery, connection, chunked writes, reassembly
src/ui/         styles
src/main.ts     the only file that touches the document
```

`protocol/` imports nothing from `transport/` and never touches the DOM, which is what lets it be tested
without a device. Its tests sit beside it and run in milliseconds.

## The protocol, briefly

The Bluetooth interface speaks the same application protocol the device uses over the network, with the body
encrypted rather than obfuscated. An eight-octet header, an AES-128-CBC body, and a CRC-16/MODBUS trailer
appended big-endian — every multi-octet field is big-endian, including the checksum, which is a deviation
from Modbus RTU.

The key and initialisation vector are fixed strings shipped in the vendor app, identical on every device.
They authenticate nothing: **anyone within Bluetooth range can speak this protocol.** Treat the interface as
unauthenticated, because it is.

One quirk a reimplementation has to match: outbound bodies are PKCS7-padded and inbound ones are not, the
plaintext being trimmed by a length field in the header instead. Web Crypto has no unpadded mode, so
`protocol/crypto.ts` synthesises a padding block the browser will accept and strip. The reasoning is in the
comment there, with a test that proves it.

## Contributing

`bun run check` must pass. If you are looking at a Zed workspace and the editor reports rules this project
has turned off, point its Biome at the config explicitly — the extension looks for `biome.json` by name and
does not find `biome.jsonc`:

```json
{ "lsp": { "biome": { "settings": { "config_path": "biome.jsonc" } } } }
```

## Licence

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).

Copyright 2026 Simon Eisenmann. See [NOTICE](NOTICE).

Heliobind interoperates with Growatt hardware through a protocol worked out by independent analysis of
Bluetooth traffic on owned equipment. It is not affiliated with, endorsed by, or derived from any source
code of Growatt New Energy Co., Ltd. "Growatt", "Nexa", "Noah", "Aura" and "Veta" are the trademarks of
their respective owners and are used here only to identify the hardware this software talks to.
