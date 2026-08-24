# nexa-ble-provision

Find and read a Growatt NEXA 2000 over Bluetooth, from a browser. Eventually: join it to a Wi-Fi network
and point it at a server of your choosing, without the vendor app.

**This version is read-only.** It can discover a device, connect, and read its configuration parameters. It
cannot change anything — there is no write path in the code at all.

> **A personal weekend project, built with heavy AI assistance.** It runs against exactly one device — the
> author's — and it is written to be honest about what has actually been observed rather than to be a
> product. Treat it accordingly. It is not affiliated with or endorsed by Growatt.

## Requirements

**Chrome on Android.** Web Bluetooth is not available in any browser on iOS, and the page will say so rather
than failing at the first tap. A desktop Chrome with a Bluetooth adapter works too, if it is close enough to
the device — a few metres of open air is not enough.

Served over HTTPS, or from `localhost`. Web Bluetooth requires a secure context.

## Running it

```sh
bun install --frozen-lockfile
bun run dev        # http://localhost:3000
```

```sh
bun run check      # lint, types, tests
bun run build      # static site into dist/
```

### Testing on a phone

Bluetooth needs a secure context, so the phone has to reach the page over HTTPS. The page itself does not
terminate TLS — put it behind a proxy that does:

Bluetooth needs a secure context, so the phone has to reach the page over HTTPS. Put an HTTPS reverse
proxy in front and point it at the development server:

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

1. Filters for devices advertising the vendor's service, so the browser's chooser shows only these.
2. Connects and subscribes to the command characteristic.
3. Sends a configuration read and decodes the reply.

The reply is shown as raw octets and as text, because how a reply body is laid out is not yet established —
raw is more honest than a guess at structure.

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
