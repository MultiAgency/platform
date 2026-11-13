import { createHash } from "node:crypto";

/** One caller's stable identity for one requested money action. */
export const requestKey = (actor: string, requestId: string) =>
  `request:${createHash("sha256").update(`${actor}\n${requestId}`).digest("hex").slice(0, 32)}`;
