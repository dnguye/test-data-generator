/* Loads the same vendored faker bundle the browser page loads.

   The API's contract is that a schemaId plus a seed reproduces the browser's
   output byte for byte. That only holds if both sides run the same generator,
   so this deliberately evaluates faker.iife.js and faker-ext.js rather than
   installing @faker-js/faker from npm -- an npm copy would drift the moment
   the vendored bundle and the registry disagree on a patch version.

   Cost is a one-off ~0.5s at cold start; generation itself is unaffected. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let cached = null;

export function loadFaker() {
  if (cached) return cached;
  const bundle = fs.readFileSync(path.join(ROOT, "faker.iife.js"), "utf8");
  const ext = fs.readFileSync(path.join(ROOT, "faker-ext.js"), "utf8");
  /* faker-ext.js is a classic script that reads a FakerLib global, so the
     global has to exist before its IIFE runs -- hence the assignment wedged
     between the two sources. */
  cached = new Function(
    bundle + "\n;globalThis.FakerLib=FakerLib;\n" + ext + "\n;return FakerLib;"
  )();
  globalThis.FakerLib = cached;
  return cached;
}
