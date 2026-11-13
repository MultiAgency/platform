import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { area } from "../contract/areas.js";

// Read-only hosted format. Keep this boundary free of gateway role/roster reads:
// dispatch is also imported by the isolated invoice host.
const entry = z.strictObject({ owner: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  kind: z.enum(["wallet", "dao"]), area, name: z.string(), port: z.number().int().min(9000).max(9999) });
const scope = { deployment: z.string().regex(/^[a-z0-9-]{1,32}$/), organization: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) };
const app = entry.extend(scope);
const released = app.extend({ agentId: z.string().min(1), at: z.iso.datetime(),
  archiveCorrelationId: z.string().nullable(), state: z.enum(["releasing", "released", "restored"]) });

export function allocationReservations(directory: string) {
  const read = (name: string) => {
    const file = join(directory, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, entries: [] };
  };
  const registry = <T extends z.ZodType>(schema: T, name: string) =>
    z.strictObject({ version: z.literal(1), entries: z.array(schema).max(1000) }).parse(read(name)).entries;
  const releases = registry(released, "released.json");
  const unavailable = new Set(releases.filter(r => r.state !== "restored").map(r => r.name));
  const names = new Set<string>(), ports = new Set<number>();
  const entries: (z.infer<typeof entry> & Partial<z.infer<typeof app>>)[] =
    [...registry(entry, "registry.json"), ...registry(app, "apps.json")];
  return entries
    .filter(e => !unavailable.has(e.name)).map(e => {
      const scoped = e.deployment !== undefined ? `app:${e.deployment}:${e.organization}:${e.owner}:${e.area}` : `${e.owner}:${e.area}`;
      const name = `own-${createHash("sha256").update(scoped).digest("hex").slice(0, 24)}`;
      const envFile = join(directory, `${e.name}.env`);
      if (e.name !== name || names.has(e.name) || ports.has(e.port) || !existsSync(envFile))
        throw new Error("Conflicting or incomplete allocation reservation");
      names.add(e.name); ports.add(e.port);
      return { ...e, envFile };
    });
}
