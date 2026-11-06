import { closeSync, linkSync, mkdirSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, statSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Persist one directory entry; filesystem sync failures propagate. */
function syncParent(path: string) {
  const fd = openSync(dirname(resolve(path)), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Ensure one state directory under an established parent. Always sync its entry:
 * existence alone does not prove an earlier attempt (or another process) synced it. */
export function mkdirSynced(path: string) {
  try { mkdirSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !statSync(path).isDirectory()) throw error;
  }
  syncParent(path);
}

/** Exclusive, durable execution claim. Keep a created marker even when syncing fails. */
export function claimSynced(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncParent(path);
  return true;
}

/**
 * Creates a file once, whole and durable: written beside it, then linked into place, which fails if the file exists.
 * Never a partial file, never a second writer's. False when it already exists.
 */
export function createOnce(path: string, text: string): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { flush: true });
  try { linkSync(tmp, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { rmSync(tmp, { force: true }); }
  syncParent(path);
  return true;
}

/**
 * Moves a file into another directory without ever replacing one: linked into place, then removed. Run again after a
 * crash it finishes the move. A different file already at the destination throws; nothing at the source returns false.
 */
export function moveOnce(from: string, to: string): boolean {
  try { linkSync(from, to); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code !== "EEXIST") throw error;
    let same: boolean;
    try { same = readFileSync(from).equals(readFileSync(to)); }
    catch (read) { if ((read as NodeJS.ErrnoException).code === "ENOENT") return false; throw read; }
    if (!same) throw new Error(`${to} already exists and differs from ${from}; investigate before continuing`);
  }
  syncParent(to);
  rmSync(from, { force: true });
  syncParent(from);
  return true;
}

/**
 * Appends one JSON line and syncs it to disk before returning; throws if it can't. After a crash
 * mid-append the file ends without a newline: this line then starts its own, so only the torn line
 * is lost, never the complete one written after it.
 */
export function appendSynced(path: string, line: object) {
  const fd = openSync(path, "a+");
  try {
    const { size } = fstatSync(fd);
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncParent(path);
}

/**
 * Replaces a file whole: written beside it, then renamed over it, so a crash mid-write leaves the
 * previous version, never a truncated one. `mode` applies to the new file.
 */
export function writeAtomic(path: string, text: string, mode?: number) {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true }); // a leftover from a crash would keep its own mode
  writeFileSync(tmp, text, { mode, flush: true });
  renameSync(tmp, path);
  syncParent(path);
}
