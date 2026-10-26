// Types for release-server.mjs (shipped as `@multiagency/sdk/release-server` and the `proto-release-server` bin).
import type { Server } from "node:http";

/** A release's `contract.json`, as the server reads it. Unknown keys are kept. */
export type ReleaseContract = {
  version: 1;
  product: string;
  required: string[];
  optional?: string[];
  /** Logical path → file in the release, for example `{ "/": "index.html", "/skill.md": "skill.md" }`. */
  entries: Record<string, string>;
  fallback?: string;
  strip?: string;
  assetPrefix?: string;
  [key: string]: unknown;
};
/** A complete release on disk: its id (the directory digest), directory and contract. */
export type Release = { id: string; dir: string; contract: ReleaseContract };

/** The release id of a directory: sha256 over its sorted relative names and bytes. */
export function digest(dir: string): string;
/** The complete release `id` under `root`. Throws when the id, contract or any declared entry is invalid. */
export function readRelease(root: string, id: string): Release;
/** Copies a complete build under `root` as its digest and returns that id; an interrupted stage never appears. */
export function stage(root: string, built: string): string;
/** Verifies release `id` (bytes and retained hashed assets) and switches `ACTIVE` to it atomically. */
export function activate(root: string, id: string): Release;
/** An HTTP server for the active release under `root`: GET/HEAD only, presentation only. Not yet listening. */
export function releaseServer(root: string): Server;
