import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Intent } from "@near-intents-agent-api/sdk";
import { DelegateAction, encodeSignedDelegateAction, generateKey, parsePublicKey, serializeDelegateAction } from "near-kit";
import { checkRequest, type PendingOwnerIntent, decodeProposals, readDelegate } from "../src/gateway/proposals.js";
import type { DaoProposal } from "../src/gateway/sign-requests.js";
import { proposalAndVote, proposalTransaction } from "../src/dao-owner.js";
import { proposalDescription } from "../src/owner-intents.js";
import { nep413Hash } from "../src/nep413.js";

const DAO = "agentic.sputnik-dao.near";

/** A NEP-413 owner intent, as the API generates one, and the request an agent server keeps for it. */
function nep413Request(message = JSON.stringify({ action: "agent_freeze", agent_id: "a".repeat(64) })): PendingOwnerIntent {
  const nonce = randomBytes(32);
  const intent = { standard: "nep413", payload: { message, nonce: nonce.toString("base64"), recipient: "api.agentsonintents.com" } } as unknown as Intent;
  const hash = nep413Hash(message, nonce, "api.agentsonintents.com").toString("hex");
  return { correlationId: "intent_1", type: "agent_freeze", expiresAt: new Date(Date.now() + 300_000).toISOString(), hash, intent, delegate: null, state: "waiting" };
}

/** A NEP-366 owner intent with a real signed delegate action, built and signed with near-kit. */
function nep366Request(method = "freeze_wallet"): PendingOwnerIntent {
  const key = generateKey();
  const publicKey = parsePublicKey(key.publicKey.toString());
  const call = { functionCall: { methodName: method, args: new TextEncoder().encode('{"wallet":"w"}'), gas: 30_000_000_000_000n, deposit: 1n } };
  const action = new DelegateAction("owner.near", "outlayer.near", [call], 5n, 100n, publicKey);
  const hash = createHash("sha256").update(serializeDelegateAction(action)).digest();
  const signature = key.sign(hash);
  const signed = encodeSignedDelegateAction(
    {
      signedDelegate: {
        delegateAction: { senderId: "owner.near", receiverId: "outlayer.near", actions: [call], nonce: 5n, maxBlockHeight: 100n, publicKey: { ed25519Key: { data: Array.from(publicKey.data) } } },
        signature: { ed25519Signature: { data: Array.from(signature.data) } },
      },
    } as never,
    "bytes",
  );
  const intent = {
    standard: "nep366",
    payload: { receiverId: "outlayer.near", actions: [{ type: "FunctionCall", params: { methodName: "freeze_wallet", args: {}, gas: "30000000000000", deposit: "1" } }] },
  } as unknown as Intent;
  return {
    correlationId: "intent_2",
    type: "agent_freeze",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    hash: hash.toString("hex"),
    intent,
    delegate: Buffer.from(signed).toString("base64"),
    state: "waiting",
  };
}

const proposal = (id: number, hash: string, { path = "agent-owner", status = "InProgress" } = {}): DaoProposal => ({
  id,
  proposer: "multiagentic.near",
  description: "Proposal from external dApp: sign on v1.signer",
  status,
  submission_time: "1791808897787569173",
  votes: {},
  kind: {
    FunctionCall: {
      receiver_id: "v1.signer",
      actions: [{ method_name: "sign", args: Buffer.from(JSON.stringify({ request: { path, payload_v2: { Eddsa: hash }, domain_id: 1 } })).toString("base64") }],
    },
  },
});

test("a NEP-413 request is verified by recomputing its hash, and its message is shown", () => {
  const check = checkRequest(nep413Request());
  assert.equal(check.kind, "verified");
  assert.deepEqual(check.kind === "verified" && check.standard === "nep413" && check.message, { action: "agent_freeze", agent_id: "a".repeat(64) });
});

test("a NEP-413 request whose payload doesn't hash to its hash is a mismatch", () => {
  const request = nep413Request();
  assert.equal(checkRequest({ ...request, hash: "00".repeat(32) }).kind, "mismatch");
});

test("a NEP-366 delegate action is read with near-kit's codec and hashes as near-kit signs it", () => {
  const request = nep366Request();
  const read = readDelegate(Buffer.from(request.delegate!, "base64"));
  assert.equal(read.hash, request.hash);
  assert.deepEqual({ receiver: read.receiver, methods: read.methods }, { receiver: "outlayer.near", methods: ["freeze_wallet"] });
  assert.deepEqual(checkRequest(request), { kind: "verified", standard: "nep366", receiver: "outlayer.near", methods: ["freeze_wallet"] });
});

test("a delegate action calling something other than the API generated is a mismatch", () => {
  assert.match(JSON.stringify(checkRequest(nep366Request("unfreeze_wallet"))), /something other than the API generated/);
});

test("each v1.signer proposal is matched, flagged or labelled", () => {
  const known = nep413Request();
  const decoded = decodeProposals(
    DAO,
    [
      proposal(40, known.hash),
      proposal(41, "ab".repeat(32)),
      proposal(39, "cd".repeat(32), { status: "Approved" }),
      proposal(38, "ef".repeat(32), { path: DAO }),
      proposal(37, "12".repeat(32), { path: "elsewhere" }),
      { ...proposal(36, "34".repeat(32)), kind: { Transfer: { receiver_id: "x.near" } } },
    ],
    { treasury: [known] },
  );
  assert.deepEqual(
    decoded.map((d) => [d.id, d.what]),
    [
      [41, "unknown"],
      [40, "agent"],
      [39, "past"],
      [38, "trezu"],
      [37, "other"],
    ],
  );
  // A request whose window closed is still recognised, with its state, rather than flagged as foreign.
  const lapsed = { ...nep413Request(), state: "expired" as const };
  const [late] = decodeProposals(DAO, [proposal(42, lapsed.hash)], { treasury: [lapsed] });
  assert.equal(late?.what === "agent" && late.state, "expired");
  const matched = decoded.find((d) => d.id === 40);
  assert.equal(matched?.what === "agent" && matched.agent, "treasury");
  assert.equal(matched?.what === "agent" && matched.check.kind, "verified");
});

test("an open proposal is not called foreign while an agent that may have prepared it didn't answer", () => {
  const known = nep413Request();
  const open = proposal(43, "ab".repeat(32));
  // The payout agent was restarting: what it waits for is unknown, not nothing.
  const [unchecked] = decodeProposals(DAO, [open], { treasury: [known], payout: null });
  assert.deepEqual(unchecked?.what === "unchecked" && unchecked.unanswered, ["payout"]);
  // Once every agent answers and none prepared it, it is flagged.
  const [flagged] = decodeProposals(DAO, [open], { treasury: [known], payout: [] });
  assert.equal(flagged?.what, "unknown");
  // A finished proposal stays past either way, and a match needs no other agent's answer.
  assert.equal(decodeProposals(DAO, [proposal(44, "cd".repeat(32), { status: "Approved" })], { payout: null })[0]?.what, "past");
  assert.equal(decodeProposals(DAO, [proposal(45, known.hash)], { treasury: [known], payout: null })[0]?.what, "agent");
});

test("a proposal a member files with a description asks for exactly the signature Trezu would", () => {
  const hash = "ab".repeat(32);
  const { receiverId, actions } = proposalTransaction(DAO, hash, "* Proposal Action: Freeze the agent", "100000000000000000000000");
  const { methodName, args, deposit } = actions[0]!.params;
  assert.deepEqual([receiverId, methodName, deposit], [DAO, "add_proposal", "100000000000000000000000"]);
  // As the DAO stores it: the proposal's kind, read back by the decoder.
  const filed: DaoProposal = { ...proposal(50, "00"), description: args.proposal.description, kind: args.proposal.kind as DaoProposal["kind"] };
  const [decoded] = decodeProposals(DAO, [filed], {});
  assert.equal(decoded?.hash, hash);
  assert.equal(decoded?.what, "unknown");
  assert.equal(decoded?.description, "* Proposal Action: Freeze the agent");
});

test("a member who may vote files and approves a proposal in one transaction, voting on exactly that proposal", () => {
  const hash = "ab".repeat(32);
  const filing = proposalTransaction(DAO, hash, "* Proposal Action: Release a held payment", "0");
  const { receiverId, actions } = proposalAndVote(DAO, hash, "* Proposal Action: Release a held payment", "0", 51);
  assert.equal(receiverId, DAO);
  assert.deepEqual(actions[0], filing.actions[0], "the same filing as a member's plain proposal");
  const vote = actions[1]!.params;
  assert.equal(vote.methodName, "act_proposal");
  // The shape Trezu sends on mainnet (proposals #45, #48, #49): the DAO checks `proposal` against the stored kind.
  assert.deepEqual(vote.args, { id: 51, action: "VoteApprove", proposal: filing.actions[0]!.params.args.proposal.kind });
  assert.equal(vote.deposit, "0");
  // One transaction carries at most 300 Tgas.
  assert.ok(actions.reduce((sum, a) => sum + BigInt(a.params.gas), 0n) <= 300_000_000_000_000n);
});

test("a policy update's public proposal never names the payees it adds", () => {
  const summary = "Allow confidential transfers to carol.near";
  const update = proposalDescription({ type: "policy_update", summary, expiresAt: "2026-10-13T00:00:00Z", hash: "ab" });
  assert.ok(!update.includes("carol.near"), update);
  assert.match(update, /Change the agent's policy/);
  const freeze = proposalDescription({ type: "agent_freeze", summary: "Freeze the agent", expiresAt: "2026-10-13T00:00:00Z", hash: "ab" });
  assert.match(freeze, /Proposal Action: Freeze the agent/, "other actions keep their summary");
});
