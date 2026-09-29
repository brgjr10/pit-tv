/*
 * tools/atomic-json.mjs — write a JSON file without a partial file on failure.
 *
 * JSON.stringify on a large object can throw mid-way; writing the result as it
 * is built leaves a truncated file on disk. This serialises to a temp file in
 * the same directory, then renames it over the target so the target is either
 * the old file or the new one — never a half-written one.
 */

import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/*
 * renameSync over a network share (SMB) fails with EPERM/EBUSY/EACCES while the
 * target is briefly locked — an oplock, a scanner, or another process holding
 * the file open. The window is short, so retrying clears it. Without this a
 * transient lock aborts the whole write and the caller surfaces a 500 for a
 * condition that has already passed by the time anyone reads the log.
 */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

// writeJsonAtomic is synchronous by contract, so the backoff has to be too.
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !TRANSIENT_RENAME_ERRORS.has(err.code)) throw err;
      sleepSync(40 * attempt);
    }
  }
}

export function writeJsonAtomic(path, value, replacer = null, space = 2) {
  const json = JSON.stringify(value, replacer, space);
  const tmp = join(dirname(path), `.tmp-${randomBytes(4).toString("hex")}-${Date.now()}.json`);
  writeFileSync(tmp, json, "utf8");
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    // The target is still the previous, valid file, but the temp would be left
    // behind otherwise. Best effort: the original error is the one that matters.
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}