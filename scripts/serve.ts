#!/usr/bin/env bun
/**
 * `bunx heliobind` — serve the built app on this machine.
 *
 * Web Bluetooth needs a secure context, which means HTTPS or `localhost`. Serving on localhost is therefore
 * the one arrangement that needs no certificate, and it is why this exists: `bunx heliobind` and a browser
 * is the whole setup.
 *
 * That also fixes what it is for. A phone cannot reach this laptop's localhost, so this is the desktop
 * path: Chrome with a Bluetooth adapter, close enough to the device. On Linux that additionally needs
 * `chrome://flags/#enable-experimental-web-platform-features`, where Web Bluetooth ships disabled.
 * Reaching this from a phone means a reverse proxy with a certificate, which the README covers and this
 * does not attempt.
 *
 * Files come from the `dist/` shipped inside the package, not from the current directory: the command is
 * meant to be run from anywhere.
 */

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..", "dist");

/** Read `--name value` and `--name=value` alike, because both are what people type. */
function option(name: string, fallback: string): string {
  const args = Bun.argv;
  const exact = args.indexOf(`--${name}`);
  if (exact !== -1 && args[exact + 1]) return args[exact + 1] as string;
  const joined = args.find((arg) => arg.startsWith(`--${name}=`));
  return joined ? joined.slice(name.length + 3) : fallback;
}

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(`heliobind — serve the Bluetooth setup app locally

  bunx heliobind [--port 8787] [--host 127.0.0.1]

Open the printed address in Chrome. Bluetooth from a web page needs a secure
context, so localhost works and a plain LAN address does not.`);
  process.exit(0);
}

if (!existsSync(join(ROOT, "index.html"))) {
  console.error(`no built app at ${ROOT}\nThis package should ship one; please report it.`);
  process.exit(1);
}

const port = Number(option("port", "8787"));
// Loopback by default. A LAN address would not be a secure context anyway, so binding wider by default
// would offer a page that cannot do the one thing it is for.
const host = option("host", "127.0.0.1");

const server = Bun.serve({
  port,
  hostname: host,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    // `normalize` collapses `..` before it is joined, so a crafted path cannot climb out of dist.
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    const candidate = join(ROOT, relative);
    const file = Bun.file(candidate);
    if (relative !== "/" && (await file.exists())) {
      return new Response(file);
    }

    // Anything else is the app: a reload deep in it, or a path the service worker has not cached.
    return new Response(Bun.file(join(ROOT, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`heliobind serving ${ROOT}
  ${server.url}

Open it in Chrome. Press Ctrl-C to stop.`);
