import type { Intent } from "@near-intents-agent-api/sdk";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connect, signIntent, useWallet } from "./features/owner/wallet";
import { Badge, Button, Card, ErrorBox, Loading } from "./shared/ui";
import "./styles.css";

/**
 * The platform's confirm page: an owner action an app prepared that the owner's wallet can't show readably (NEP-366).
 * The platform holds it and shows its own record of it here. The owner first signs this link's readable text, which
 * releases the bytes to this page only, then signs those bytes with the same wallet. Standalone: no platform session,
 * nothing but this one action.
 */
type Policy = Record<string, unknown>;
type View = {
  deployment: string; organization: string; agent: string; owner: string; type: string; action: Record<string, unknown>;
  policy: { current: Policy | null; requested: Policy } | null; summary: string | null; expiresAt: string;
  signer: { account_id: string; public_key: string }; opening: { message: string; recipient: string; nonce: string };
  state: "open" | "submitted" | "expired";
};

const TITLES: Record<string, string> = {
  agent_create: "Create the agent", agent_freeze: "Freeze the agent", agent_unfreeze: "Unfreeze the agent",
  policy_update: "Change the agent's policy", grant_issue: "Issue a grant", grant_revoke: "Revoke a grant", approval_vote: "Vote on a held payout",
};
const token = location.pathname.split("/").pop() ?? "";
const api = `/confirm/v1/${token}`;
const errorOf = async (response: Response) => {
  const body = await response.json().catch(() => null) as { error?: string; json?: { message?: string } } | null;
  return body?.error ?? body?.json?.message ?? `HTTP ${response.status}`;
};

const show = (value: unknown) => <pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(value, null, 2)}</pre>;

/**
 * The terms from the agent's own record: a policy edit as every field that changes, including ones derived from what
 * the app asked (turning transfers on or off with the payee list); a creation as the whole policy; otherwise the action.
 */
function Terms({ view }: { view: View }) {
  const { policy } = view;
  if (policy?.current) {
    const changed = Object.keys({ ...policy.current, ...policy.requested })
      .filter(key => JSON.stringify(policy.current![key]) !== JSON.stringify(policy.requested[key]));
    return <dl className="grid gap-3">
      {changed.map(key => <div key={key}>
        <dt className="text-sm font-medium">{key}</dt>
        <dd className="grid gap-1 sm:grid-cols-2"><div><span className="text-sm text-muted-foreground">Now</span>{show(policy.current![key])}</div>
          <div><span className="text-sm text-muted-foreground">After signing</span>{show(policy.requested[key])}</div></dd>
      </div>)}
      {!changed.length && <p>No field changes.</p>}
    </dl>;
  }
  const { type: _type, ...fields } = view.action;
  return <dl className="grid gap-3">
    {Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => <div key={key}>
      <dt className="text-sm text-muted-foreground">{key}</dt><dd>{show(value)}</dd>
    </div>)}
    {policy && <div><dt className="text-sm text-muted-foreground">The agent's policy at creation</dt><dd>{show(policy.requested)}</dd></div>}
  </dl>;
}

function ConfirmPage() {
  const wallet = useWallet();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string>();
  const [stage, setStage] = useState<"idle" | "signing" | "submitted">("idle");
  useEffect(() => {
    fetch(api).then(async response => response.ok ? setView(await response.json() as View) : setError(await errorOf(response)))
      .catch(() => setError("The platform didn't answer. Reload to try again."));
  }, []);

  async function sign() {
    if (!view) return;
    setError(undefined);
    setStage("signing");
    try {
      // First the link's readable text, proving this is the owner's wallet; only then does the platform hand over the bytes.
      const opened = await signIntent({ standard: "nep413", payload: view.opening } as Intent);
      const opening = await fetch(`${api}/open`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: opened.signature }) });
      if (!opening.ok) throw new Error(await errorOf(opening));
      const { intent } = await opening.json() as { intent: Intent };
      const signedData = await signIntent(intent);
      const response = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedData }) });
      if (!response.ok) throw new Error(await errorOf(response));
      setStage("submitted");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStage("idle");
    }
  }

  if (!view) return error ? <ErrorBox error={error} /> : <Loading label="Loading the action…" />;
  const owner = wallet.status === "connected" && wallet.accountId === view.owner;
  return <Card>
    <h1 className="text-xl font-semibold">{TITLES[view.type] ?? view.type}</h1>
    <p>
      App deployment <strong>{view.deployment}</strong> asks <strong>{view.owner}</strong> to sign this for Organization{" "}
      <strong>{view.organization}</strong>, agent <strong>{view.agent}</strong>.
    </p>
    {view.summary && <p className="text-muted-foreground">Provider's summary: {view.summary}</p>}
    <Terms view={view} />
    <p className="text-sm text-muted-foreground">
      Check that this page is on <strong>{location.host}</strong>. Your wallet can't show these terms, so this page is the
      platform's record of them. Your wallet asks twice: first to sign a short text naming this page and action, then the
      action itself. Never sign that text anywhere else. Signable until {new Date(view.expiresAt).toLocaleString()}.
    </p>
    {error && <ErrorBox error={error} />}
    {stage === "submitted" || view.state === "submitted" ? <Badge tone="success">Submitted. The app follows the outcome; you can close this page.</Badge>
      : view.state === "expired" ? <Badge tone="warning">Expired unsigned. Ask the app to prepare it again.</Badge>
      : !owner ? <div className="flex flex-col items-start gap-2">
          {wallet.status === "connected" && <p role="alert">Connected as {wallet.accountId}. Connect {view.owner} to sign.</p>}
          <Button onClick={() => void connect()} disabled={wallet.status === "connecting"}>Connect {view.owner}</Button>
        </div>
      : <Button onClick={() => void sign()} disabled={stage === "signing"}>{stage === "signing" ? "Signing…" : "Sign and submit"}</Button>}
  </Card>;
}

const dark = matchMedia("(prefers-color-scheme: dark)");
document.documentElement.classList.toggle("dark", dark.matches);
createRoot(document.getElementById("root")!).render(<StrictMode><main className="mx-auto flex max-w-2xl flex-col gap-4 p-6"><ConfirmPage /></main></StrictMode>);
