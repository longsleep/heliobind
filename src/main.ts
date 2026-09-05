/**
 * Entry point.
 *
 * Deliberately empty of logic. The bundler's entry has one job — start the thing — and keeping it at that
 * means the layers below can be read in any order:
 *
 * | Layer | Knows about |
 * |---|---|
 * | `protocol/` | bytes, and nothing else. Pure and tested without hardware |
 * | `transport/` | GATT, and nothing about what it carries |
 * | `device.ts` | both, and the only place they meet |
 * | `ui/` | the document and the session, never framing or the radio |
 */

import { start } from "./ui/app.ts";

await start();
