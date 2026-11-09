import { Wallet as WalletIcon } from "@phosphor-icons/react";
import { Badge as WalletBadge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { observeOwnerAction } from "./owner-observation";
import { client, errorMessage, minutesSeconds, short, useCountdown } from "../../shared/lib";
import { Button, Spinner } from "../../shared/ui";
import { useCanCall, useViewer } from "../../app/viewer";
import { connect, dao, disconnect, ownerWallet, sendAsMember, signIntent, useWallet } from "./wallet";
import { isTerminal } from "../../../../src/operation-status.js";

export type Setup = Awaited<ReturnType<typeof client.setup>>;
export type Destination = { address: string; confidential: boolean };
export type OwnerAction = Parameters<typeof client.owner.prepare>[0]["action"];
export type PolicyChanges = Extract<OwnerAction, { type: "policy_update" }>["changes"];

/** Whether an owner action ended the way it was meant to: a rejected payment is a reject vote's success. */
type OwnerTransport = Pick<typeof client.owner, "prepare" | "submit" | "status" | "actions">;
async function ended(transport: OwnerTransport, action: OwnerAction, correlationId: string, status?: string, failureCode?: string | null) {
  if (action.type === "approval_vote") {
    const record = (await transport.actions()).find(a => a.correlationId === correlationId);
    if (record?.ownerSucceeded) return;
    throw new Error("Owner approval outcome could not be confirmed. Review the existing owner action before signing again.");
  }
  if (status === "SUCCESS") return;
  throw new Error(failureCode ?? `Ended ${status?.toLowerCase()}`);
}

export type Signer = "wallet" | "dao";
/** Who signs this agent's owner actions: the linked DAO when its owner account owns the agent. */
export const ownerSigner = (setup: Setup): Signer =>
  setup.dao && setup.owner?.type === "near" && setup.owner.account_id === setup.dao.owner.account_id ? "dao" : "wallet";

/** Trezu connected as `daoId`, connecting first when it isn't. */
export async function ensureDao(daoId: string) {
  const current = (await dao.connector.getConnectedWallet().catch(() => null))?.accounts[0]?.accountId;
  if (current !== daoId) await dao.connect();
  const connected = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (connected !== daoId) throw new Error(`Trezu is connected as ${connected}, not ${daoId}`);
}

/**
 * Runs one owner action end to end. The owner's wallet signs the API's payload directly; a DAO
 * files one proposal through Trezu asking its MPC key to sign, and the server submits the
 * signature once the vote passes, inside the API's signing window.
 */
export function useOwnerAction(setup: Setup, options?: { transport: OwnerTransport; followHref: string }) {
  const transport = options?.transport ?? client.owner;
  const queryClient = useQueryClient();
  const observation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; observation.current?.abort(); }; }, []);
  const [correlationId, setCorrelationId] = useState<string>();
  const remember = (id: string) => { if (mounted.current) setCorrelationId(id); };
  async function follow(id: string, action: OwnerAction) {
    const controller = observation.current!;
    const state = await observeOwnerAction(signal => transport.status({ correlationId: id }, { signal }), controller.signal,
      state => { if (state.stage === "submitting") setStep("settling"); });
    if (state.stage === "submitted") return ended(transport, action, id, state.status, state.failureCode);
    if (state.stage === "expired") throw new Error("The signing window closed. Review the existing owner action.");
    if (state.stage === "failed") throw new Error("error" in state ? state.error : "Owner action failed");
    throw new Error("Owner action needs review. Follow its existing record before signing again.");
  }
  const viewer = useViewer();
  const canPrepare = useCanCall("owner/prepare");
  // A caller may await fresh records before invoking an older render's run callback.
  const permissions = useRef({ viewer, canPrepare });
  permissions.current = { viewer, canPrepare };
  const [step, setStep] = useState<"idle" | "preparing" | "signing" | "filing" | "voting" | "settling">("idle");
  const [deadline, setDeadline] = useState<string>();
  const [error, setError] = useState<string>();
  /** For a policy update, the digest of the mandate being signed. */
  const [digest, setDigest] = useState<string | null>(null);
  const left = useCountdown(step === "voting" ? deadline : undefined);

  async function viaDao(action: OwnerAction) {
    if (!setup.dao) throw new Error("Link the DAO as the treasury first");
    // A signed-in member who may file proposals files it from their own wallet, with a description
    // saying what it signs; otherwise Trezu files it, as a generic "sign on v1.signer".
    const ownWallet = permissions.current.viewer?.access?.canPropose ?? false;
    if (!ownWallet) await ensureDao(setup.dao.id);
    const prepared = await transport.prepare({ action, signer: "dao" });
    if (!("dao" in prepared) || !prepared.dao) throw new Error("The server did not prepare a DAO signature");
    remember(prepared.correlationId);
    observation.current!.signal.throwIfAborted();
    setDigest(prepared.digest);
    setStep("filing");
    // A member who may also vote files and casts their vote together; the DAO threshold still applies.
    const filing = permissions.current.viewer?.access?.canVote && prepared.dao.proposalAndVote ? prepared.dao.proposalAndVote : prepared.dao.proposal;
    if (ownWallet && filing) {
      const outcome = (await sendAsMember(filing)) as { status?: { Failure?: unknown } } | undefined;
      // Reverted as one, so nothing was filed: most likely another proposal took the id the vote named.
      if (outcome?.status?.Failure) throw new Error(`The transaction failed, so nothing was filed. Try again. ${JSON.stringify(outcome.status.Failure)}`);
    }
    else {
      if (ownWallet) await ensureDao(setup.dao.id);
      await dao.send(prepared.dao.transaction);
    }
    setDeadline(prepared.expiresAt);
    setStep("voting");
    // The server watches for the DAO's signature and submits it; follow it to the end.
    await follow(prepared.correlationId, action);
  }

  async function viaWallet(action: OwnerAction) {
    const prepared = await transport.prepare({
      action: action.type === "agent_create" ? { ...action, owner: await ownerWallet() } : action,
      signer: "wallet",
    });
    if (!("intent" in prepared) || !prepared.intent) throw new Error("The server did not prepare a wallet signature");
    remember(prepared.correlationId);
    observation.current!.signal.throwIfAborted();
    setDigest(prepared.digest);
    setStep("signing");
    const signedData = await signIntent(prepared.intent);
    setStep("settling");
    try {
      const result = await transport.submit({ correlationId: prepared.correlationId, signedData });
      if (isTerminal(result.status))
        return ended(transport, action, prepared.correlationId, result.status, result.failureCode);
    } catch (error) {
      const state = await transport.status({ correlationId: prepared.correlationId });
      if (state.stage !== "submitting" && state.stage !== "submitted") throw error;
    }
    // An accepted or ambiguous submission is followed by ID, never signed or sent again.
    await follow(prepared.correlationId, action);
  }

  /** Whether the action ended as meant; otherwise `error` says why. */
  async function run(action: OwnerAction, signer: Signer = ownerSigner(setup)) {
    if (!mounted.current) return false;
    const current = permissions.current;
    const permitted = current.viewer === null || (signer === "dao" ? current.viewer.access?.canPropose : current.viewer.access?.canSign);
    if (!current.canPrepare || !permitted) {
      setError(signer === "dao" ? "Your account cannot propose this owner action." : "Your account cannot sign this owner action.");
      return false;
    }
    observation.current?.abort();
    observation.current = new AbortController();
    setCorrelationId(undefined);
    setError(undefined);
    try {
      setStep("preparing");
      await (signer === "dao" ? viaDao(action) : viaWallet(action));
      return true;
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
      return false;
    } finally {
      if (mounted.current) { setStep("idle"); setDeadline(undefined); setDigest(null); }
      await queryClient.invalidateQueries();
    }
  }

  const label = {
    idle: null,
    preparing: "Preparing…",
    signing: "Approve in your wallet…",
    filing: viewer?.access?.canPropose ? `Confirm the proposal${viewer.access.canVote ? " and your vote" : ""} in your wallet…` : "File the proposal in Trezu…",
    voting: `Waiting for ${setup.dao?.id ?? "the DAO"} to approve · ${left === null ? "" : `${minutesSeconds(left)} left`}`,
    settling: "Checking the owner action’s outcome…",
  }[step];
  return { run, correlationId, busy: step !== "idle", label: (label || correlationId) && <>{label}{setup.dao && (step === "voting" || step === "settling") && <> · <a className="underline" target="_blank" rel="noopener noreferrer" href={`https://trezu.app/${setup.dao.id}/requests`}>Review and vote in Trezu</a></>}{correlationId && <> · {options ? <a href={options.followHref} className="underline">Follow work order</a> : <Link to="/activity" hash={`owner-${correlationId}`} className="underline">Follow owner action</Link>}</>}</>, error, digest };
}

/**
 * Who signs as the agent's owner from this page: the DAO through Trezu, or the owner's own wallet, which
 * must be connected first and must be the owner's account.
 */
export function useSigner(setup: Setup) {
  const wallet = useWallet();
  const viewer = useViewer();
  const canPrepare = useCanCall("owner/prepare");
  const viaDao = ownerSigner(setup) === "dao";
  const walletIsOwner = setup.owner?.type === "near" && wallet.accountId === setup.owner.account_id;
  const permitted = canPrepare && (viewer === null || (viaDao ? viewer.access?.canPropose : viewer.access?.canSign));
  const canSign = Boolean(permitted && (viaDao || walletIsOwner));
  return {
    viaDao,
    canSign,
    permitted: Boolean(permitted),
    needsWallet: Boolean(permitted && !viaDao && wallet.status !== "connected"),
    connectedNotOwner: !viaDao && wallet.status === "connected" && !walletIsOwner,
  };
}

export function ownerName(setup: Setup) {
  if (ownerSigner(setup) === "dao") return `${setup.dao?.id} (by proposal)`;
  return setup.owner?.type === "near" ? setup.owner.account_id : "the owner's wallet";
}

export function WalletButton() {
  const wallet = useWallet();
  if (wallet.status === "connected" && wallet.accountId)
    return (
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <WalletBadge variant="neutral" className="h-auto min-h-6 max-w-full whitespace-normal">
          <WalletIcon size={12} weight="bold" /> <span className="min-w-0 break-all font-mono">{short(wallet.accountId)}</span>
        </WalletBadge>
        <Button variant="ghost" size="sm" className="h-auto max-w-full whitespace-normal py-3" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  return (
    <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-3" disabled={wallet.status === "connecting"} onClick={() => connect().catch(() => {})}>
      {wallet.status === "connecting" ? <Spinner /> : <WalletIcon size={16} />}
      Connect wallet
    </Button>
  );
}
