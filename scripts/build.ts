/**
 * Production build.
 *
 * A script rather than a long CLI line in `package.json`, because the build stamps a commit reference into
 * the page and getting that through two layers of shell quoting is how a silent empty string happens. It
 * also injects the content security policy, which needs a plugin.
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { serviceWorker } from "./service-worker.ts";

/**
 * Which transport the bundle will contain, and therefore where it goes.
 *
 * `--android` resolves `#transport` to the Capacitor implementation through the `capacitor` condition, and
 * writes somewhere of its own so the two builds cannot overwrite each other. The browser build is the
 * default in every sense: it is what a bare `bun run build` produces, what Pages serves, and what the npm
 * package carries — `files` lists `dist` and nothing else, so Android code cannot reach the registry.
 */
const ANDROID = process.argv.includes("--android");
const OUT = ANDROID ? "dist-android" : "dist";

/**
 * The policy the shipped page carries.
 *
 * `connect-src 'none'` is the load-bearing directive: it makes exfiltrating a passphrase something the
 * browser refuses, rather than something a reader has to rule out by auditing every line.
 *
 * It is injected here rather than written into `index.html` because the development server needs an inline
 * script and a WebSocket for hot reload. Relaxing the policy far enough to let it work would relax the one
 * that ships, so the strict version belongs to the build.
 *
 * Everything the page loads is a file of its own — the bundler emits the stylesheet as a chunk and links
 * it, and there are no inline styles, no inline scripts and no images. So `'self'` covers scripts and
 * styles with nothing left over, and every other fetch falls through to `default-src 'none'`. Adding an
 * icon or an inline style later is a deliberate change that has to widen this list.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // The icon set and the manifest, added when the app became installable. `connect-src` stays shut: the
  // page itself fetches nothing, and a service worker's own requests are not governed by the page policy.
  "img-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // No frame-ancestors: it is one of the three directives a meta tag cannot carry, alongside report-uri
  // and sandbox, and listing it here would only look like protection. Framing can be forbidden by a real
  // response header, which GitHub Pages cannot serve — see the README.
].join("; ");

/** Whatever CI passes; "development" locally so the page never claims a provenance it lacks. */
const buildRef = process.env.BUILD_REF?.trim() || "development";

/**
 * Whether to compile the protocol constants into the page.
 *
 * Set by `bun run build:local`, and by nothing else. `.env.local` alone is not enough: it is read by the
 * dev server, where prefilling is harmless, and would otherwise silently reach a tarball through any build
 * run on this machine.
 */
const inlineConstants = process.env.HELIOBIND_INLINE === "1";

/** The names src/settings.ts reads, and the only ones a build may answer. */
const CONSTANT_NAMES = [
  "BUN_PUBLIC_HELIOBIND_CIPHER_KEY",
  "BUN_PUBLIC_HELIOBIND_CIPHER_IV",
  "BUN_PUBLIC_HELIOBIND_BIND_KEY",
] as const;

/**
 * What each `process.env.NAME` becomes in the bundle.
 *
 * Every name is substituted on every build — with the value when one was asked for, with an empty string
 * otherwise. Naming them explicitly is the point of doing it this way. Bun's `env` prefix option only
 * substitutes variables that are *set*, so an absent one is left standing as `process.env.NAME`, and a
 * browser has no `process` to evaluate that against: the module throws while being imported and the page is
 * blank. Listing the names means the substitution does not depend on the environment having them.
 */
const substitutions = Object.fromEntries(
  CONSTANT_NAMES.map((name) => [
    `process.env.${name}`,
    JSON.stringify(inlineConstants ? (process.env[name] ?? "") : ""),
  ]),
);

/** The values that must not appear in a build that did not ask for them. */
const constants = Object.entries(process.env)
  .filter(([name]) => name.startsWith("BUN_PUBLIC_HELIOBIND_"))
  .map(([, value]) => value)
  .filter((value): value is string => Boolean(value));

/**
 * Insert the policy immediately after the charset declaration.
 *
 * `HTMLRewriter` is a real parser, so this does not depend on how the source happens to be formatted —
 * which a regex over markup always does. Placing it after the charset keeps that tag inside the first
 * 1024 octets, where the parser needs it, while still putting the policy ahead of every resource.
 */
const securityPolicy: BunPlugin = {
  name: "content-security-policy",
  setup(build) {
    build.onLoad({ filter: /\.html$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const contents = new HTMLRewriter()
        .on("meta[charset]", {
          element(element) {
            element.after(`\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`, {
              html: true,
            });
          },
        })
        .transform(source);
      return { contents, loader: "html" };
    });
  },
};

await rm(OUT, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: OUT,
  minify: true,
  sourcemap: "none",
  plugins: [securityPolicy],
  // The condition that decides which transport `#transport` resolves to. Nothing selects it at runtime:
  // a browser bundle has no Capacitor in it to select.
  conditions: ANDROID ? ["capacitor"] : [],
  // Nothing from the environment reaches the browser on its own. `substitutions` above is the only route,
  // and it carries a value only under `bun run build:local` — a build that carries the protocol constants
  // is a convenience for one phone, and a build that carries them by accident is a publication. Asking for
  // it has to be typed on purpose rather than being what happens when .env.local exists.
  env: "disable",
  define: {
    __BUILD_REF__: JSON.stringify(buildRef),
    ...substitutions,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// A missing policy would be invisible in a page that otherwise works perfectly, so assert rather than
// trust the plugin ran.
const built = await readFile(join(OUT, "index.html"), "utf8");
if (!built.includes("connect-src 'none'")) {
  console.error("the content security policy is not in the built page; refusing to ship it");
  process.exit(1);
}

/*
 * No `process` may survive into the browser.
 *
 * A page that reads one is not subtly wrong, it is dead: `ReferenceError` while the module is being
 * imported, before anything renders, with only the console to say so. Every known reader is substituted
 * above, so anything left is a new one that nobody has arranged for — the case worth failing on, since
 * neither the type checker nor the tests can see it. Tests run in Bun, where `process` exists.
 */
for (const output of result.outputs.filter(({ path }) => path.endsWith(".js"))) {
  if ((await readFile(output.path, "utf8")).includes("process.env")) {
    console.error(`${output.path} reads process.env, which does not exist in a browser`);
    process.exit(1);
  }
}

/*
 * The icons the manifest asks for.
 *
 * Everything the *page* links — the stylesheet, the favicon, the manifest itself — the bundler finds,
 * hashes and rewrites. It does not read the manifest's JSON, so the icons named only in there would be
 * missing. They are copied to a fixed path because that is the path the manifest states, and a hashed name
 * would need the manifest rewritten to match.
 */
await mkdir(join(OUT, "icons"), { recursive: true });
const iconNames = (await readdir("icons")).filter((name) => name.endsWith(".png") || name.endsWith(".svg"));
for (const name of iconNames) {
  await copyFile(join("icons", name), join(OUT, "icons", name));
}

/*
 * The screenshots the manifest names, copied for the same reason as the icons: the bundler does not read
 * the manifest's JSON, and a hashed name would need the manifest rewritten to match.
 *
 * Not precached, for the same reason the licence below is not. They are shown by the browser's install
 * card and never by the app, so an offline copy is half a megabyte spent on something nobody will see.
 */
await mkdir(join(OUT, "screenshots"), { recursive: true });
for (const name of (await readdir("screenshots")).filter((name) => name.endsWith(".png"))) {
  await copyFile(join("screenshots", name), join(OUT, "screenshots", name));
}

// The built page is a distribution of the work, so the licence and the notice travel with it. Not
// precached: they are not part of the app shell, and an offline copy of a licence helps nobody.
for (const name of ["LICENSE", "NOTICE"]) {
  await copyFile(name, join(OUT, name));
}

/**
 * Precache everything the app is made of, named from what was actually emitted.
 *
 * Bun hashes its chunks, so a hand-written list would go stale in silence: the worker would precache a
 * chunk that no longer exists, installation would fail, and the app would keep serving the old cache with
 * nothing to say it had. `./` is listed as well as the emitted files because that is the URL a navigation
 * asks for.
 */
const assets = [
  "./",
  ...result.outputs.map((output) => `./${output.path.replace(`${process.cwd()}/${OUT}/`, "")}`),
  ...iconNames.map((name) => `./icons/${name}`),
];
await writeFile(join(OUT, "sw.js"), serviceWorker(`heliobind-${buildRef}`, assets));

/*
 * Prove it, rather than trust the switch above.
 *
 * The check is the part that has to hold: if some later change gives the constants a second route into the
 * bundle, `env: "disable"` would not stop it and nothing else would notice. Reading them from the
 * environment is only how the search terms are obtained — on a machine that has none, there is nothing to
 * find and this passes trivially.
 */
if (!inlineConstants) {
  for (const output of result.outputs) {
    const text = await readFile(output.path, "utf8").catch(() => "");
    const found = constants.find((constant) => text.includes(constant));
    if (found) {
      console.error(`${output.path} carries a protocol constant; refusing to produce this build`);
      process.exit(1);
    }
  }
}

console.error(
  `built ${result.outputs.length} files into ${OUT}/ as ${buildRef}` +
    (inlineConstants ? " with the protocol constants compiled in" : ""),
);
for (const output of result.outputs) {
  console.error(`  ${output.path.replace(`${process.cwd()}/`, "")}  ${output.size} bytes`);
}
console.error(`  ${OUT}/sw.js  precaching ${assets.length} files`);
