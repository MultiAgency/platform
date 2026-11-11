import type { Intent } from "@near-intents-agent-api/sdk";
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ASSETS } from "../../src/contract/assets.js";
import { EVERY_AGENT, walletStopMessage } from "../../src/gateway/wallet-stop-text.js";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fromUnits } from "./features/payables/payment-copy";
import { connect, connectStopWallet, signIntent, signStopIntent, signStopMessage, switchStopWallet, useStopWallet, useWallet } from "./features/owner/wallet";
import { Badge, Button, Card, ErrorBox, Loading } from "./shared/ui";
import "./styles.css";

/**
 * The platform's confirm page: an owner action an app prepared whose terms the owner's wallet can't show: a NEP-366
 * action, or a vote on a held payout, whose text names no payee or amount. The platform shows its own record of it here.
 * For a NEP-366 action, whose bytes the app wasn't given, the owner first signs this link's readable text, which releases
 * them to this page only; then the owner signs them with the same wallet. A vote's text the app holds too, so the page
 * signs it directly. Standalone: no platform session, nothing but this one action.
 */
type Policy = Record<string, unknown>;
type Repeats = { checked: true; payouts: { correlationId: string; at: string; status: string }[] } | { checked: false };
type Payment = { correlationId: string; verdict: "approve" | "reject"; terms: { recipient: string; asset: string; amount: string; chain?: "near" } | null;
  repeats?: Repeats };
type View = {
  deployment: string; organization: string; agent: string; owner: string; type: string; action: Record<string, unknown>;
  policy: { current: Policy | null; requested: Policy } | null; summary: string | null; expiresAt: string; payment: Payment | null;
  signer: { account_id: string; public_key: string };
  state: "open" | "submitted" | "expired";
} & (
  /** NEP-366: the text that releases the bytes held on the platform. */
  | { opening: { message: string; recipient: string; nonce: string }; intent?: never }
  /** A vote on a held payout: the app holds its text too, so the page signs it directly. */
  | { intent: Intent; opening?: never }
);

const TITLES: Record<string, string> = {
  agent_create: "Create the agent", agent_freeze: "Freeze the agent", agent_unfreeze: "Unfreeze the agent",
  agent_archive: "Archive the agent", agent_restore: "Restore the agent",
  policy_update: "Change the agent's policy", grant_issue: "Issue a grant", grant_revoke: "Revoke a grant", approval_vote: "Vote on a held payout",
};
const token = location.pathname.split("/").pop() ?? "";
const api = `/confirm/v1/${token}`;
const errorOf = async (response: Response) => {
  const body = await response.json().catch(() => null) as { error?: string; json?: { message?: string } } | null;
  return body?.error ?? body?.json?.message ?? `HTTP ${response.status}`;
};

const show = (value: unknown) => <pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(value, null, 2)}</pre>;
const DECIMALS: Record<string, [number, string]> = { [ASSETS.USDC]: [6, "USDC"], [ASSETS.wNEAR]: [24, "wNEAR"] };

/**
 * A vote's payout as the agent proved it against the provider's request hash: what an approve releases, exactly,
 * with the raw amount and asset beside any readable form.
 */
function PaymentTerms({ payment }: { payment: Payment }) {
  const { terms } = payment;
  if (!terms) return <p>Reject held payout <code>{payment.correlationId}</code>: this vote releases nothing.</p>;
  const known = DECIMALS[terms.asset];
  const row = (label: string, value: ReactNode) => <div><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>;
  return <dl className="grid gap-3">
    {row("Pays", <strong>{terms.recipient}</strong>)}
    {row("Amount", <><strong>{known ? `${fromUnits(terms.amount, known[0])} ${known[1]}` : `${terms.amount} raw units`}</strong>
      <span className="block text-sm text-muted-foreground">{terms.amount} raw units of {terms.asset}</span></>)}
    {row("How", terms.chain === "near" ? "A public withdrawal to the NEAR account, which may arrive less a route fee" : "A confidential transfer")}
    {row("Held payout", <code>{payment.correlationId}</code>)}
    {payment.repeats && row("Paid before", <PaidBefore repeats={payment.repeats} />)}
  </dl>;
}

/**
 * Earlier payouts of the same payee, asset and amount in the last 24 hours, from the payment provider's history. A second
 * payment of one invoice looks like any new payout; this is where the owner sees the first. It never stops a vote.
 */
function PaidBefore({ repeats }: { repeats: Repeats }) {
  if (!repeats.checked) return <span>Couldn't check: the payment provider's history for the last 24 hours couldn't be read in full.</span>;
  if (!repeats.payouts.length) return <span>No payout of these terms in the last 24 hours.</span>;
  return <div className="grid gap-1">
    <strong>The same payee, asset and amount {repeats.payouts.length === 1 ? "was" : "were"} already paid in the last 24 hours.
      Check this isn't a second payment of one invoice.</strong>
    <ul className="text-sm">{repeats.payouts.map(p =>
      <li key={p.correlationId}><code>{p.correlationId}</code>, {new Date(p.at).toLocaleString()}, {p.status.toLowerCase().replace(/_/g, " ")}</li>)}</ul>
  </div>;
}

/**
 * The terms from the agent's own record: a policy edit as every field that changes, including ones derived from what
 * the app asked (turning transfers on or off with the payee list); a creation as the whole policy; otherwise the action.
 */
function Terms({ view }: { view: View }) {
  const { policy } = view;
  if (view.payment) return <PaymentTerms payment={view.payment} />;
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

/** The link's readable text, signed first to prove this is the owner's wallet; only then does the platform hand over the bytes. */
async function open(text: { message: string; recipient: string; nonce: string }) {
  const opened = await signIntent({ standard: "nep413", payload: text } as Intent);
  const opening = await fetch(`${api}/open`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature: opened.signature }) });
  if (!opening.ok) throw new Error(await errorOf(opening));
  return (await opening.json() as { intent: Intent }).intent;
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
      const signedData = await signIntent(view.intent ?? await open(view.opening));
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
  const prompts = view.intent ? "Your wallet asks once, for the action itself." : "Your wallet asks twice: first to sign a short text naming this page and action, then the action itself. Never sign that text anywhere else.";
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
      platform's record of them{view.payment ? ", checked against the payment provider's own record of the held payout" : ""}. {prompts}{" "}
      Signable until {new Date(view.expiresAt).toLocaleString()}.
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

/** What the stop's answer says of an agent's freeze (src/gateway/wallet-stop.ts). */
type Freeze = { state: "sign"; correlationId: string; expiresAt: string; intent: Intent; signer: { account_id: string; public_key: string } }
  | { state: "submitted"; correlationId: string } | { state: "not prepared" | "expired"; reason: string };
type Stopped = { at: string; agents: { agent: string; agentId: string | null; consentsEnded: number; autopilot: string; freeze?: Freeze }[] };
type StopBody = { message: string; nonce: string; publicKey: string; signature: string };
/** Where the page is with one agent's freeze after the stop: signing, sent, the agent's `owner/status` of it, or why not. */
type Following = { stage: "signing" | "sent"; status?: Record<string, unknown>; error?: string };
/** The agent this page's link names (`/confirm/wallet/stop/<agent>`), if any. */
const stopNamed = location.pathname.match(/^\/confirm\/wallet\/stop\/([a-z0-9-]{1,32})$/)?.[1] ?? null;
/** The stop text is good for 10 minutes; the page renews it once less than 2 remain, so what it shows is always signable. */
const STOP_VALID_MS = 10 * 60_000, RENEW_BELOW_MS = 2 * 60_000;
const stopExpiry = () => new Date(Date.now() + STOP_VALID_MS).toISOString();
/** Freezes the stop won't prepare however often it is sent. */
const FINAL = new Set(["not created", "replaced", "owner changed"]);
const post = async (path: string, body: unknown) => {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await errorOf(response));
  return response.json() as Promise<Record<string, unknown>>;
};
/** The agent's `owner/status` of a freeze in words: the provider's status once it has one. */
const statusWords = (status: Record<string, unknown> | undefined) =>
  !status ? "sent" : typeof status.status === "string" ? `${status.status}${typeof status.failureCode === "string" ? ` (${status.failureCode})` : ""}` : String(status.stage ?? "sent");

/**
 * A wallet owner's own stop (src/gateway/wallet-stop.ts): no app and no platform session. The owner connects the wallet
 * that owns the agents, reads the exact text, and signs it; the platform then ends every app consent given for them before
 * it applies the stop and turns their autopilot off. The same signed stop is sent again to finish an autopilot not yet
 * confirmed off. Asked to freeze too (the text then says so), the platform hands back each agent's freeze as the provider
 * generated it; the owner's wallet signs exactly that, and the platform sends it to the agent's own `owner/submit`.
 */
function StopPage() {
  const wallet = useStopWallet();
  const [scope, setScope] = useState<string>(stopNamed ?? EVERY_AGENT);
  const [freeze, setFreeze] = useState(false);
  const [sent, setSent] = useState<StopBody>();
  const [stopped, setStopped] = useState<Stopped>();
  const [following, setFollowing] = useState<Record<string, Following>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const account = wallet.status === "connected" ? wallet.accountId : null;
  const [expiresAt, setExpiresAt] = useState(stopExpiry);
  useEffect(() => {
    const timer = setInterval(() => setExpiresAt(current => Date.parse(current) - Date.now() < RENEW_BELOW_MS ? stopExpiry() : current), 15_000);
    return () => clearInterval(timer);
  }, []);
  const message = account ? walletStopMessage({ host: location.host, owner: account, agent: scope, expiresAt, ...(freeze && { freeze: true }) }) : null;

  async function send(body: StopBody) {
    setError(undefined); setBusy(true);
    try {
      const answer = await post("/confirm/v1/wallet-stop", body) as unknown as Stopped;
      setSent(body);
      setStopped(answer);
      setFollowing(current => Object.fromEntries(Object.entries(current).filter(([agent]) => answer.agents.find(a => a.agent === agent)?.freeze?.state === "submitted")));
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
  const follow = (agent: string, next: Following) => setFollowing(current => ({ ...current, [agent]: next }));
  /** The agent's own `owner/status` of its freeze. */
  async function check(agent: string) {
    if (!sent) return;
    try { follow(agent, { stage: "sent", status: (await post("/confirm/v1/wallet-stop/freeze-status", { stop: sent, agent })).status as Record<string, unknown> }); }
    catch (failure) { follow(agent, { stage: "sent", error: failure instanceof Error ? failure.message : String(failure) }); }
  }
  /** The owner's wallet signs exactly the provider's intent the stop handed back; the platform sends it to the agent's `owner/submit`. */
  async function signFreeze(agent: string, intent: Intent) {
    if (!sent) return;
    follow(agent, { stage: "signing" });
    try {
      const signedData = await signStopIntent(intent);
      await post("/confirm/v1/wallet-stop/freeze", { stop: sent, agent, signedData });
    } catch (failure) {
      follow(agent, { stage: "signing", error: failure instanceof Error ? failure.message : String(failure) });
      return;
    }
    follow(agent, { stage: "sent" });
    await check(agent);
  }

  const unconfirmed = stopped?.agents.some(a => a.autopilot === "not confirmed off");
  const freezing = stopped?.agents.some(a => a.freeze);
  const retry = unconfirmed || stopped?.agents.some(a => a.freeze?.state === "not prepared" && !FINAL.has(a.freeze.reason))
    || Object.values(following).some(f => f.stage === "signing" && f.error);
  const freezeCell = (agent: string, f: Freeze | undefined) => {
    if (!f) return null;
    const now = following[agent];
    if (f.state === "submitted" || now?.stage === "sent") return <div className="flex flex-col items-start gap-1">
      <span>Freeze {statusWords(now?.status)}</span>
      {now?.error && <span role="alert" className="text-destructive">{now.error}</span>}
      <Button size="sm" variant="outline" onClick={() => void check(agent)}>Check the freeze of {agent}</Button>
    </div>;
    if (f.state !== "sign") return <span>{f.state === "expired" ? f.reason : `Freeze not prepared: ${f.reason}`}</span>;
    return <div className="flex flex-col items-start gap-1">
      <Button size="sm" onClick={() => void signFreeze(agent, f.intent)} disabled={now?.stage === "signing" && !now.error}>
        {now?.stage === "signing" && !now.error ? "Signing…" : `Sign the freeze of ${agent}`}</Button>
      <span className="text-muted-foreground">Signable until {new Date(f.expiresAt).toLocaleString()}</span>
      {now?.error && <span role="alert" className="text-destructive">{now.error}</span>}
    </div>;
  };
  return <Card>
    <h1 className="text-xl font-semibold">Stop your agents</h1>
    <p>
      Signed by the wallet that owns them, this ends every app consent you gave for them before the stop is applied, and
      turns their autopilot off. No app is involved. It doesn't revoke a grant, so an app you consent to again may turn
      autopilot back on. A swap already under way finishes through the platform's guarded send path.
    </p>
    <p>
      To stop every send, freeze them too: the payment provider then refuses every new send until you unfreeze, which
      this page doesn't offer. Your wallet signs each freeze exactly as the provider generated it, within about 10 minutes
      of the stop.
    </p>
    <p className="text-sm text-muted-foreground">Check that this page is on <strong>{location.host}</strong>.</p>
    {error && <ErrorBox error={error} />}
    {stopped ? <>
      <Badge tone={unconfirmed ? "warning" : "success"}>{unconfirmed ? "Consents ended; some autopilot not confirmed off" : "Stopped"}</Badge>
      <table className="text-sm"><thead><tr><th className="text-left">Agent</th><th className="text-left">Consents ended</th><th className="text-left">Autopilot</th>
        {freezing && <th className="text-left">Freeze</th>}</tr></thead>
        <tbody>{stopped.agents.map(a => <tr key={a.agent}><td>{a.agent}</td><td>{a.consentsEnded}</td><td>{a.autopilot}</td>
          {freezing && <td>{freezeCell(a.agent, a.freeze)}</td>}</tr>)}</tbody></table>
      <p className="text-sm text-muted-foreground">Applied {new Date(stopped.at).toLocaleString()}.</p>
      {freezing && Object.values(following).some(f => f.error?.includes("delegate actions")) &&
        <Button variant="outline" onClick={() => void switchStopWallet()}>Connect another wallet</Button>}
      {retry && sent && <Button onClick={() => void send(sent)} disabled={busy}>{busy ? "Sending…" : "Send the same stop again"}</Button>}
    </> : !account ? <Button onClick={() => void connectStopWallet()} disabled={wallet.status === "connecting"}>Connect the owner's wallet</Button>
      : <>
        <p>Connected as <strong>{account}</strong>.</p>
        {stopNamed && <ToggleGroup type="single" variant="outline" value={scope} onValueChange={value => { if (value) setScope(value); }} aria-label="Agents to stop" className="flex-wrap">
          <ToggleGroupItem value={stopNamed}>Only agent {stopNamed}</ToggleGroupItem>
          <ToggleGroupItem value={EVERY_AGENT}>Every agent of {account} on this host</ToggleGroupItem>
        </ToggleGroup>}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={freeze} onChange={event => setFreeze(event.target.checked)} />
          <span>Freeze them too: no new sends until I unfreeze</span>
        </label>
        <h2 className="font-medium">The exact text your wallet signs</h2>
        <pre className="whitespace-pre-wrap break-all text-sm">{message}</pre>
        <p className="text-sm text-muted-foreground">{scope === EVERY_AGENT ? "\"agent\": \"*\" means every agent this wallet owns here. " : ""}
          {freeze ? "\"freeze\": true asks for each agent's freeze, which your wallet then signs. " : ""}Valid until {new Date(expiresAt).toLocaleString()}.</p>
        <Button onClick={() => void sign()} disabled={busy}>{busy ? "Signing…" : freeze ? "Sign, stop and prepare the freeze" : "Sign and stop"}</Button>
      </>}
  </Card>;
}

const dark = matchMedia("(prefers-color-scheme: dark)");
document.documentElement.classList.toggle("dark", dark.matches);
const stopPage = location.pathname.startsWith("/confirm/wallet/stop");
createRoot(document.getElementById("root")!).render(<StrictMode><main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">{stopPage ? <StopPage /> : <ConfirmPage />}</main></StrictMode>);
