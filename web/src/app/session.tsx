import { SignIn as SignInIcon, SignOut } from "@phosphor-icons/react";
import type { FrontendArea as Area } from "../../../src/contract/areas.js";
import { useState } from "react";
import { errorMessage, gw } from "../shared/lib";
import { Button, Card, ErrorBox, Spinner } from "../shared/ui";
import { type GatewayViewer, useViewer } from "./viewer";
import { signChallenge, signOutMember } from "../shared/wallet";

/** An agent behind the gateway and the account it answers to; `dao` when that account is a DAO, signing by proposal. */
export type GatewayAgent = { name: string; owner: string; dao: boolean; area?: Area; invoices?: string | null };
/** The agent's area as the gateway reports it; an agent named "treasury" predates the reported area. */
export const areaOf = (agent: GatewayAgent): Area => agent.area ?? (agent.name === "treasury" ? "treasury" : "payables");
export type Gateway = { demo?: "showcase" | "payables" | "treasury" | "invoices"; agents: GatewayAgent[]; invoices: string | null; viewer: GatewayViewer | null; apps?: Partial<Record<"payables" | "treasury", string>>; walkthroughs?: boolean; selfService?: boolean; setupAreas?: Area[] };

/** The agents' owners, each once, in order. Signed out, the gateway lists only DAOs' agents, so these are DAOs. */
export const ownersOf = (agents: GatewayAgent[]) => [...new Set(agents.map((a) => a.owner))];

/**
 * The gateway's view of this visitor, or null when the page is served by a local agent server, which
 * answers /gw/me with the page itself. An error from a gateway, or from the proxy in front of it,
 * throws: a hosted page must never fall back to the trusted local view on loopback.
 */
export async function loadGateway(): Promise<Gateway | null> {
  const response = await fetch(/\/access\/?$/.test(location.pathname) ? "/gw/access-session" : "/gw/me");
  if (!response.headers.get("content-type")?.includes("application/json")) {
    if (response.ok) return null;
    // A proxy's error page in front of a gateway that is down, not a local server.
    throw new Error(`The dashboard answered ${response.status}.`);
  }
  const body = (await response.json()) as Gateway & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The dashboard answered ${response.status}`);
  return body;
}

export async function signOut() {
  await fetch("/gw/logout", { method: "POST" });
  await signOutMember().catch(() => {});
  location.assign("/");
}

export function SignIn({ daos, compact = false, selfService = false }: { daos: string[]; compact?: boolean; selfService?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const challenge = await gw<{ message: string; recipient: string; nonce: string }>("/gw/challenge");
      await gw("/gw/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await signChallenge(challenge)),
      });
      // Back to the page they asked for: signed out, any address shows the public page in its place.
      // A reload, not assign: assigning a URL with a hash is a fragment navigation and loads nothing.
      location.reload();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const action = <>
    <ErrorBox error={error} />
    <span role="status" className="sr-only">{busy ? "Complete sign-in in your NEAR wallet." : ""}</span>
    <Button className="w-fit" onClick={signIn} disabled={busy}>
      {busy ? <Spinner /> : <SignInIcon size={16} aria-hidden="true" />} {busy ? "Connecting…" : "Connect wallet"}
    </Button>
  </>;
  if (compact) return <div className="flex max-w-sm flex-col items-start gap-2">{action}</div>;
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{selfService ? "Sign in to get started" : "Members"}</h2>
        <p className="text-sm text-muted-foreground">
          {selfService ? "Sign in with your regular NEAR wallet. You can then create an agent owned by that wallet, or select a DAO through Trezu using your member account." : <>Sign in with the NEAR wallet that owns an agent here{daos.length > 0 && `, or as a member of ${daos.join(" or ")}`}.</>} Signing in sends nothing on chain.
        </p>
      </div>
      {action}
    </Card>
  );
}

export function ViewerBadge() {
  const viewer = useViewer();
  if (!viewer) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="truncate" title={viewer.account}>
          {viewer.account}
        </span>
        <span className="text-muted-foreground">Signed in</span>
      </div>
      <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out">
        <SignOut size={16} />
      </Button>
    </div>
  );
}
