/*
 * tools/atomic-json.mjs — write a JSON file without a partial file on failure.
 *
 * JSON.stringify on a large object can throw mid-way; writing the result as it
 * is built leaves a truncated file on disk. This serialises to a temp file in
 * the same directory, then renames it over the target so the target is either
 * the old file or the new one — never a half-written one.
 */

import { writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function writeJsonAtomic(path, value, replacer = null, space = 2) {
  const json = JSON.stringify(value, replacer, space);
  const tmp = join(dirname(path), `.tmp-${randomBytes(4).toString("hex")}-${Date.now()}.json`);
  writeFileSync(tmp, json, "utf8");
  renameSync(tmp, path);
}