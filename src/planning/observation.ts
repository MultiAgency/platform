import { agentId } from "../env.js";
import { holdings } from "../holdings.js";
import { api } from "../api.js";
import { mandateDigest } from "../mandate.js";
import { loadStrategy } from "../strategy.js";
import { strategyDigest } from "../strategy-digest.js";
import type { Snapshot } from "./model.js";

/** The state a preview is taken against, and that execution must still find. */
export async function snapshot(): Promise<Snapshot> {
  return (await observe()).snapshot;
}

/** The snapshot, the book it was read from, and the assets the live policy lets a swap buy. */
export async function observe() {
  const [book, view] = await Promise.all([holdings(), api.getPolicy(agentId())]);
  const snapshot: Snapshot = {
    agentId: agentId(),
    policyRevision: view.revision,
    policyDigest: view.policy ? mandateDigest(view.policy) : null,
    strategyDigest: strategyDigest(loadStrategy()),
    balances: Object.fromEntries(
      book.map((h) => [h.asset, { public: h.public.toString(), confidential: h.confidential.toString() }]),
    ),
  };
  return { snapshot, book, assets: view.policy?.assets ?? [], view };
}
