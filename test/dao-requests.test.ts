import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { generateKey } from "near-kit";
import { MAX_PROPOSAL_MS } from "../src/contract/treasury-proposals.js";
import { DaoRequests, type DaoFiling, type DaoVotes, MAX_PENDING_DAO_REQUESTS } from "../src/gateway/app-dao.js";
import { nep413Hash, rawKey } from "../src/nep413.js";

const DAY = 86_400_000, NOW = Date.parse("2026-11-08T00:00:00Z"), HOST = "platform.test", DAO = "agentic.sputnik-dao.near";
const BOND = "100000000000000000000000";

/** A DAO request store on a fresh root, with the DAO's chain reads simulated: no proposal passed until `pass`. */
function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dao-requests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = generateKey(), public_key = key.publicKey.toString();
  const signer = { account_id: rawKey(public_key).toString("hex"), public_key };
  const chain = { block: 1_000, next: 57 as number | null, down: false, findDown: false, searches: 0, passed: new Map<string, Buffer>(),
    /** Run while the block is read, or the DAO's proposals searched, as chain reads in flight. */
    reading: () => {}, searching: () => {} };
  const votes: DaoVotes = {
    latestBlock: async () => { chain.reading(); if (chain.down) throw new Error("rpc down"); return chain.block; },
    nextProposalId: async () => { if (chain.next === null) throw new Error("rpc down"); return chain.next; },
    findSignature: async (_dao, { hash }) => { chain.searches++; chain.searching(); if (chain.findDown) throw new Error("indexer down"); return chain.passed.get(hash) ?? null; },
  };
  /** A passed `v1.signer` proposal: the DAO's derived key signs the hash (or another key does). */
  const pass = (hash: string, by = key) => { chain.passed.set(hash, Buffer.from(by.sign(Buffer.from(hash, "hex")).data)); };
  const consent = (over: Partial<Extract<DaoFiling, { kind: "consent" }>> = {}): Extract<DaoFiling, { kind: "consent" }> => ({ kind: "consent", deployment: "staging", host: HOST,
    organization: "org_1", dao: DAO, agent: "treasury", agentId: "provider-id", scopes: ["read", "treasury"], expiresAt: NOW + 30 * DAY,
    message: "consent text", signer, ...over });
  const stop = (): Extract<DaoFiling, { kind: "stop" }> => ({ kind: "stop", host: HOST, dao: DAO, agent: "treasury", agentId: "provider-id", expiresAt: NOW + 7 * DAY, message: "stop text", signer });
  const log = (record: { id: string }) => ({ event: "filed", request: record.id });
  const requests = new DaoRequests(root, votes);
  const file = <F extends DaoFiling>(filing: F, stopping = () => false) => requests.file(filing, { bond: BOND, stopping, log, now: NOW });
  const filed = async <F extends DaoFiling>(filing: F) => { const result = await file(filing); assert.equal(result.state, "filed"); return result.record; };
  const logLines = () => readdirSync(root).filter(f => f.startsWith("access-")).flatMap(f => readFileSync(join(root, f), "utf8").trim().split("\n")).map(l => JSON.parse(l));
  return { root, requests, chain, pass, consent, stop, file, filed, logLines, otherKey: generateKey() };
}

test("filing picks the nonce, reads the block, records the request and its log line, and answers its transactions", async t => {
  const { requests, file, consent, logLines } = harness(t);
  const result = await file(consent());
  assert.equal(result.state, "filed");
  const { record, transactions } = result;
  assert.equal(record.id, nep413Hash("consent text", Buffer.from(record.nonce, "base64"), HOST).toString("hex"));
  assert.equal(record.since, 1_000);
  assert.equal(record.createdAt, NOW);
  assert.equal(record.votingUntil, NOW + MAX_PROPOSAL_MS, "within Sputnik's default proposal period, before the consent expires");
  assert.match(record.description, new RegExp(record.id));
  assert.deepEqual(requests.read(record.id), record);
  assert.deepEqual(logLines(), [{ at: new Date(NOW).toISOString(), event: "filed", request: record.id }]);
  assert.equal(transactions.proposal.actions.length, 1);
  assert.ok(transactions.proposalAndVote, "the next proposal id was read");
});

test("a filing's vote window ends when what it signs expires, if that is sooner", async t => {
  const { filed, consent } = harness(t);
  assert.equal((await filed(consent({ expiresAt: NOW + DAY }))).votingUntil, NOW + DAY);
});

test("an unread next proposal id leaves out only the proposal-and-vote transaction", async t => {
  const { file, consent, chain } = harness(t);
  chain.next = null;
  const result = await file(consent());
  assert.equal(result.state, "filed");
  assert.equal(result.transactions.proposalAndVote, null);
});

test("nothing is filed when the chain can't be read, or while the gateway is stopping, before or after the read", async t => {
  const { root, file, consent, chain, logLines } = harness(t);
  chain.down = true;
  assert.deepEqual(await file(consent()), { state: "unreadable" });
  chain.down = false;
  assert.deepEqual(await file(consent(), () => true), { state: "stopping" });
  let stopping = false;
  chain.reading = () => { stopping = true; };
  assert.deepEqual(await file(consent(), () => stopping), { state: "stopping" });
  assert.equal(readdirSync(root).includes("dao-requests"), false);
  assert.deepEqual(logLines(), []);
});

test("a deployment's pending requests are limited; a DAO's stop isn't counted against any deployment", async t => {
  const { file, filed, consent, stop } = harness(t);
  for (let i = 0; i < MAX_PENDING_DAO_REQUESTS; i++) await filed(consent({ message: `consent ${i}` }));
  await assert.rejects(file(consent({ message: "one more" })), { code: "dao_requests_limited" });
  await filed(consent({ message: "another deployment", deployment: "production" }));
  assert.equal((await filed(stop())).deployment, "");
});

test("a request is pending until its DAO's signature is found, which is verified and recorded before it is answered", async t => {
  const { requests, filed, consent, pass, chain, otherKey } = harness(t);
  const record = await filed(consent());
  assert.deepEqual(await requests.follow(record, NOW + 1), { state: "pending" });
  pass(record.id, otherKey);
  assert.deepEqual(await requests.follow(record, NOW + 1), { state: "pending" }, "a signature by another key isn't the DAO's");
  pass(record.id);
  const signed = await requests.follow(record, NOW + 1);
  assert.equal(signed.state, "signed");
  assert.ok(requests.read(record.id)?.signature);
  // Recorded: a later follow completes from it without reading the chain.
  chain.findDown = true;
  const again = await requests.follow(requests.read(record.id)!, NOW + 2);
  assert.equal(again.state, "signed");
  assert.deepEqual(again.signature, signed.signature);
});

test("an unreadable search decides nothing", async t => {
  const { requests, filed, consent, chain } = harness(t);
  const record = await filed(consent());
  chain.findDown = true;
  assert.deepEqual(await requests.follow(record, NOW + 1), { state: "unreadable" });
  assert.equal(requests.read(record.id)?.signature, undefined);
});

test("an app's request lapses at its vote window without another search, and nothing completes once what it signs expires", async t => {
  const { requests, filed, consent, pass, chain } = harness(t);
  const record = await filed(consent({ expiresAt: NOW + DAY }));
  pass(record.id);
  const searched = chain.searches;
  assert.deepEqual(await requests.follow(record, record.expiresAt), { state: "expired" }, "passed, but what it signs expired");
  const open = await filed(consent({ message: "longer" }));
  pass(open.id);
  assert.deepEqual(await requests.follow(open, open.votingUntil), { state: "lapsed" });
  assert.equal(chain.searches, searched, "not searched once its window closed");
  assert.equal(requests.read(open.id)?.signature, undefined);
  // Signed in time, but completed only until what it signs expires.
  assert.equal((await requests.follow(open, NOW + 1)).state, "signed");
  assert.deepEqual(await requests.follow(requests.read(open.id)!, open.expiresAt), { state: "expired" });
});

test("a DAO's stop is honoured late: searched once more after its window, and lapsed, on record, only if no vote passed", async t => {
  const { requests, filed, stop, pass } = harness(t);
  const passedLate = await filed(stop());
  pass(passedLate.id);
  assert.equal((await requests.follow(passedLate, passedLate.expiresAt + DAY)).state, "signed", "neither its window nor its expiry ends it");
  const unpassed = await filed(stop());
  assert.deepEqual(await requests.follow(unpassed, unpassed.votingUntil - 1), { state: "pending" });
  assert.deepEqual(await requests.follow(unpassed, unpassed.votingUntil), { state: "lapsed" });
  assert.equal((requests.read(unpassed.id) as { lapsed?: boolean }).lapsed, true);
});

test("following keeps what was recorded on the request while the chain was read", async t => {
  const { requests, filed, consent, stop, pass, chain } = harness(t);
  const record = await filed(consent()), stopped = await filed(stop());
  pass(record.id);
  // A DAO stop applied meanwhile ends the consent request: the signature found must not erase that mark.
  chain.searching = () => requests.endFiledBefore(stopped, NOW + 1);
  const signed = await requests.follow(record, NOW + 1);
  assert.equal(signed.state, "signed");
  const stored = requests.read(record.id);
  assert.equal(stored?.kind === "consent" && stored.stoppedBy, stopped.id);
  assert.ok(stored?.signature);
});
