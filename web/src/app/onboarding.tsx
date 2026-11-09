import { UsersThree, Wallet as WalletIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { client, errorMessage, short, useAttempt } from "../shared/lib";
import { ensureDao, type Setup, type Signer, useOwnerAction } from "../features/owner/owner";
import { Button, Card, ErrorBox, input, Section, Spinner, Step } from "../shared/ui";
import { connect, dao, send, useWallet } from "../features/owner/wallet";
import { SetupActions, useSetupActions } from "./setup-progress";
import { useCanCall, useViewer } from "./viewer";
import { useGateway } from "./gateway-context";
import { BASE } from "../shared/client";

/** Connects a DAO in Trezu and links it as the treasury. */
async function linkTrezuDao() {
  await dao.connect();
  const id = (await dao.connector.getConnectedWallet()).accounts[0]?.accountId;
  if (!id) throw new Error("Trezu returned no DAO account");
  await client.treasury.link({ accountId: id });
}

function ActionRow({ label, busy, disabled, onClick, children }: { label: ReactNode; busy: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={busy || disabled} onClick={onClick}>
        {busy && <Spinner />} {children}
      </Button>
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  );
}

/**
 * Onboarding. The owner is a person's wallet, or a DAO through Trezu: then an account only the
 * DAO's votes can sign for owns the agent, and every owner action is one proposal.
 */
export function Onboarding({ setup }: { setup: Setup }) {
  const queryClient = useQueryClient();
  const wallet = useWallet();
  const daoWallet = dao.use();
  const action = useOwnerAction(setup);
  const existing = useSetupActions(true);
  const viewer = useViewer();
  const reserved = useGateway()?.agents.find(agent => `/a/${agent.name}` === BASE && agent.name.startsWith("own-"));
  const canLink = useCanCall("treasury/link");
  const canPrepare = useCanCall("owner/prepare");
  const [choice, setChoice] = useState<Signer | null>(setup.dao ? "dao" : null);
  const [funding, setFunding] = useState<string>();
  const [role, setRole] = useState<"treasury" | "payout">(reserved?.area === "payables" ? "payout" : "treasury");
  const [payees, setPayees] = useState(setup.dao?.id ?? "");
  const payeeList = payees.split(/[\s,]+/).filter(Boolean);
  const signer: Signer = choice ?? "wallet";
  const isDao = signer === "dao" && Boolean(setup.dao);
  const canCreate = canPrepare && (viewer === null || (signer === "dao" ? viewer.access?.canPropose : viewer.access?.canSign));

  const chosen = isDao ? true : wallet.status === "connected";
  type StepId = "owner" | "fund" | "create" | "grant";
  const steps: StepId[] = isDao ? ["owner", "fund", "create", "grant"] : ["owner", "create", "grant"];
  // Mounted only before the agent exists: creating it, and then its grant, are still ahead.
  const done: Record<StepId, boolean> = { owner: chosen, fund: Boolean(setup.dao?.funded), create: false, grant: false };
  const current = steps.find((s) => !done[s]);
  const status = (s: StepId) => (done[s] ? "complete" : s === current ? "current" : "upcoming");

  // Poll while the owner account's funding proposal is out.
  useEffect(() => {
    if (!funding || setup.dao?.funded) return;
    const timer = setInterval(() => queryClient.invalidateQueries({ queryKey: ["setup"] }), 5_000);
    return () => clearInterval(timer);
  }, [funding, setup.dao?.funded, queryClient]);

  const linking = useAttempt();
  const linkDao = () => linking.attempt(async () => {
    if (!canLink) return;
    await linkTrezuDao();
    setChoice("dao");
  });

  const fundOwner = (daoId: string, owner: string, via: "dao" | "wallet") => async () => {
    const transfer = { receiverId: owner, actions: [{ type: "Transfer" as const, params: { deposit: "50000000000000000000000" } }] };
    setFunding(via === "dao" ? "Awaiting the DAO wallet. Funding is not confirmed." : "Awaiting the wallet. Funding is not confirmed.");
    try {
      if (via === "dao") {
        await ensureDao(daoId);
        await dao.send(transfer);
      } else await send(transfer);
      setFunding("The wallet request returned. Review the existing request and check setup status to confirm the owner account exists.");
    } catch (e) {
      setFunding(errorMessage(e));
    }
  };

  let n = 0;
  return (
    <Section
      title="Set up the agent"
      description={
        isDao
          ? `${setup.dao?.id} is the selected owner. Its members approve actions through Trezu. A wallet connection or proposal alone does not confirm policy or grant application.`
          : "Connect the owner's wallet, create the agent with its policy, then review permissions for its next task. Connecting a wallet does not authorize the agent to move funds."
      }
    >
      <p className="text-sm">Next: {existing.blocked ? "check existing setup actions before creating an agent." : current === "owner" ? "choose and connect the owner." : current === "fund" ? "check or create the DAO’s owner account." : "review the selected area and create its agent."}</p>
      {reserved && <p className="break-all text-sm">Selected owner: {reserved.owner}. This setup is reserved for {reserved.area === "payables" ? "Payables" : "Portfolio"}. <a href="/" className="underline">Choose another setup</a>.</p>}
      <SetupActions state={existing} />
      <Card>
        <ol className="flex flex-col">
          <Step
            number={++n}
            title="Choose the owner"
            status={status("owner")}
            summary={isDao ? `DAO ${setup.dao?.id}, through Trezu` : wallet.accountId && <span className="font-mono">{wallet.accountId}</span>}
          >
            <p className="text-sm text-muted-foreground">
              The owner sets the policy, issues grants and can freeze the agent. A DAO owns it through an account only its
              votes can sign for.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant={choice === "dao" ? "outline" : "default"} disabled={wallet.status === "connecting" || reserved?.dao} onClick={() => { setChoice("wallet"); connect().catch(() => {}); }}>
                <WalletIcon size={18} /> My wallet
              </Button>
              <Button variant="outline" disabled={daoWallet.status === "connecting" || !canLink || Boolean(reserved)} onClick={linkDao}>
                {daoWallet.status === "connecting" ? <Spinner /> : <UsersThree size={18} />} A DAO, through Trezu
              </Button>
            </div>
            <ErrorBox error={linking.error} />
          </Step>
          {isDao && setup.dao && (
            <Step
              number={++n}
              title="Create the DAO's owner account"
              status={status("fund")}
              summary={<span className="font-mono">{short(setup.dao.owner.account_id)}</span>}
            >
              <p className="text-sm text-muted-foreground">
                Its only key is derived from {setup.dao.id} by NEAR's MPC network, so only the DAO's proposals can sign for
                it. Sending it 0.05 NEAR creates it; any account can. If you already requested funding, review that request in your wallet or Trezu and check setup status before sending again.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={fundOwner(setup.dao.id, setup.dao.owner.account_id, "dao")}>
                  <UsersThree size={18} /> Fund from the DAO
                </Button>
                <Button variant="outline" disabled={wallet.status !== "connected"} onClick={fundOwner(setup.dao.id, setup.dao.owner.account_id, "wallet")}>
                  <WalletIcon size={18} /> Fund from my wallet
                </Button>
              </div>
              {funding && <p className="text-sm text-muted-foreground">{funding}</p>}
            </Step>
          )}
          <Step
            number={++n}
            title="Create the agent"
            status={status("create")}
            summary={setup.agentId && <span className="font-mono">{short(setup.agentId)}</span>}
          >
            <p className="text-sm text-muted-foreground">
              Creates the agent's account with the policy for the area selected below. The owner must authorize
              destinations before the agent can pay them. A signature or proposal alone does not confirm that the policy is applied; review its reported state after creation.
            </p>
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" disabled={Boolean(reserved)} checked={role === "treasury"} onChange={() => setRole("treasury")} />
                <span>
                  <span className="font-medium">Portfolio agent.</span>{" "}
                  <span className="text-muted-foreground">Swaps between USDC, wNEAR and ETH inside caps, with no vote per action.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" disabled={Boolean(reserved)} checked={role === "payout"} onChange={() => setRole("payout")} />
                <span>
                  <span className="font-medium">Payout agent.</span>{" "}
                  <span className="text-muted-foreground">
                    Pays agreed payees in USDC, confidentially. Every payout waits for the owner's approval; at most 25 USDC a
                    payout, 50 a day, 200 a month.
                  </span>
                </span>
              </label>
            </div>
            {role === "payout" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Agreed payees (NEAR Intents accounts, separated by commas)</span>
                <input className={input} value={payees} onChange={(e) => setPayees(e.target.value)} />
              </label>
            )}
            <ErrorBox error={action.error} />
            <ActionRow
              label={action.label}
              busy={action.busy}
              disabled={!canCreate || existing.blocked || (reserved && !reserved.dao && wallet.accountId !== reserved.owner) || (role === "payout" && payeeList.length === 0)}
              onClick={() => action.run({ type: "agent_create", role, payees: role === "payout" ? payeeList : undefined }, signer)}
            >
              {isDao ? "Propose creating the agent" : "Create agent"}
            </ActionRow>
          </Step>
          <Step number={++n} title="Issue the agent's grant" status={status("grant")} last />
        </ol>
      </Card>
    </Section>
  );
}
