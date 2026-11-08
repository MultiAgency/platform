import type { Intent } from "@near-intents-agent-api/sdk";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EVERY_AGENT, walletStopMessage } from "../../src/gateway/wallet-stop-text.js";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { connect, connectStopWallet, signIntent, signStopMessage, useStopWallet, useWallet } from "./features/owner/wallet";
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

type Stopped = { at: string; agents: { agent: string; agentId: string | null; consentsEnded: number; autopilot: string }[] };
type StopBody = { message: string; nonce: string; publicKey: string; signature: string };
/** The agent this page's link names (`/confirm/wallet/stop/<agent>`), if any. */
const stopNamed = location.pathname.match(/^\/confirm\/wallet\/stop\/([a-z0-9-]{1,32})$/)?.[1] ?? null;
/** The stop text is good for 10 minutes; the page renews it once less than 2 remain, so what it shows is always signable. */
const STOP_VALID_MS = 10 * 60_000, RENEW_BELOW_MS = 2 * 60_000;
const stopExpiry = () => new Date(Date.now() + STOP_VALID_MS).toISOString();

/**
 * A wallet owner's own stop (src/gateway/wallet-stop.ts): no app and no platform session. The owner connects the wallet
 * that owns the agents, reads the exact text, and signs it; the platform then ends every app consent given for them before
 * it applies the stop and turns their autopilot off. The same signed stop is sent again to finish an autopilot not yet
 * confirmed off.
 */
function StopPage() {
  const wallet = useStopWallet();
  const [scope, setScope] = useState<string>(stopNamed ?? EVERY_AGENT);
  const [sent, setSent] = useState<StopBody>();
  const [stopped, setStopped] = useState<Stopped>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const account = wallet.status === "connected" ? wallet.accountId : null;
  const [expiresAt, setExpiresAt] = useState(stopExpiry);
  useEffect(() => {
    const timer = setInterval(() => setExpiresAt(current => Date.parse(current) - Date.now() < RENEW_BELOW_MS ? stopExpiry() : current), 15_000);
    return () => clearInterval(timer);
  }, []);
  const message = account ? walletStopMessage({ host: location.host, owner: account, agent: scope, expiresAt }) : null;

  async function send(body: StopBody) {
    setError(undefined); setBusy(true);
    try {
      const response = await fetch("/confirm/v1/wallet-stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await errorOf(response));
      setSent(body);
      setStopped(await response.json() as Stopped);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  }
  async function sign() {
    if (!message) return;
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    setError(undefined); setBusy(true);
    try {
      const signed = await signStopMessage({ message, recipient: location.host, nonce });
      await send({ message, nonce, ...signed });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }

  const unconfirmed = stopped?.agents.some(a => a.autopilot === "not confirmed off");
  return <Card>
    <h1 className="text-xl font-semibold">Stop your agents</h1>
    <p>
      Signed by the wallet that owns them, this ends every app consent you gave for them before the stop is applied, and
      turns their autopilot off. No app is involved. It only removes authority: it doesn't freeze an agent or revoke its
      grant, so an app you consent to again may turn autopilot back on. A swap already under way finishes through the
      platform's guarded send path.
    </p>
    <p className="text-sm text-muted-foreground">Check that this page is on <strong>{location.host}</strong>.</p>
    {error && <ErrorBox error={error} />}
    {stopped ? <>
      <Badge tone={unconfirmed ? "warning" : "success"}>{unconfirmed ? "Consents ended; some autopilot not confirmed off" : "Stopped"}</Badge>
      <table className="text-sm"><thead><tr><th className="text-left">Agent</th><th className="text-left">Consents ended</th><th className="text-left">Autopilot</th></tr></thead>
        <tbody>{stopped.agents.map(a => <tr key={a.agent}><td>{a.agent}</td><td>{a.consentsEnded}</td><td>{a.autopilot}</td></tr>)}</tbody></table>
      <p className="text-sm text-muted-foreground">Applied {new Date(stopped.at).toLocaleString()}.</p>
      {unconfirmed && sent && <Button onClick={() => void send(sent)} disabled={busy}>{busy ? "Sending…" : "Send the same stop again"}</Button>}
    </> : !account ? <Button onClick={() => void connectStopWallet()} disabled={wallet.status === "connecting"}>Connect the owner's wallet</Button>
      : <>
        <p>Connected as <strong>{account}</strong>.</p>
        {stopNamed && <ToggleGroup type="single" variant="outline" value={scope} onValueChange={value => { if (value) setScope(value); }} aria-label="Agents to stop" className="flex-wrap">
          <ToggleGroupItem value={stopNamed}>Only agent {stopNamed}</ToggleGroupItem>
          <ToggleGroupItem value={EVERY_AGENT}>Every agent of {account} on this host</ToggleGroupItem>
        </ToggleGroup>}
        <h2 className="font-medium">The exact text your wallet signs</h2>
        <pre className="whitespace-pre-wrap break-all text-sm">{message}</pre>
        <p className="text-sm text-muted-foreground">{scope === EVERY_AGENT ? "\"agent\": \"*\" means every agent this wallet owns here. " : ""}Valid until {new Date(expiresAt).toLocaleString()}.</p>
        <Button onClick={() => void sign()} disabled={busy}>{busy ? "Signing…" : "Sign and stop"}</Button>
      </>}
  </Card>;
}

const dark = matchMedia("(prefers-color-scheme: dark)");
document.documentElement.classList.toggle("dark", dark.matches);
const stopPage = location.pathname.startsWith("/confirm/wallet/stop");
createRoot(document.getElementById("root")!).render(<StrictMode><main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">{stopPage ? <StopPage /> : <ConfirmPage />}</main></StrictMode>);
