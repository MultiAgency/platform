import { AREAS, type Area } from "./contract/areas.js";
export type { Area };

/** Absent on legacy/local instances until explicitly configured. Never infer authorization here. */
export function configuredArea(value: string | undefined): Area | undefined {
  if (!value) return undefined;
  if ((AREAS as readonly string[]).includes(value)) return value as Area;
  throw new Error(`DASHBOARD_AREA must be one of ${AREAS.join(", ")}`);
}
