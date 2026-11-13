import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { additionalIncomingCredits, recordIncomingCredit, readIncomingCredits, type IncomingCredit } from "../src/incoming-credits.js";
import { assertProviderCredit } from "../src/record-incoming-credit.js";
const sample = (extra: Partial<IncomingCredit> = {}): IncomingCredit => ({ agent: "agent", recipient: "wallet.near", asset: "nep141:usdc", amount: "10000000", settledAt: "2026-01-01T12:00:00Z", source: { issuer: "https://receipts.example", receiptId: "fixture:credit-1" }, recordedBy: "owner operator", recordedAt: "2026-01-02T12:00:00Z", evidence: "operator-receipt", ...extra });
const receipt = Buffer.from("Executed funding receipt; synthetic fixture");
const root = () => join(mkdtempSync(join(tmpdir(), "incoming-credit-")), "credits");
test("receipt-backed credits persist without touching an execution journal; repeat import is idempotent", () => {
 const dir = root(); assert.deepEqual(readIncomingCredits("agent", dir), []);
 assert.equal(recordIncomingCredit(sample(), receipt, dir).created, true);
 assert.equal(recordIncomingCredit(sample({ recordedAt: "2026-01-03T12:00:00Z" }), receipt, dir).created, false);
 const credits = readIncomingCredits("agent", dir); assert.equal(credits.length, 1);
 assert.equal(additionalIncomingCredits(credits, [], "wallet.near").totals.get("nep141:usdc"), 10000000n);
});
test("conflicting terms, changed receipts, malformed amounts and future settlement refuse", () => {
 const dir = root();recordIncomingCredit(sample(), receipt, dir);
 for(const extra of [{ amount:"20000000" }, {recipient:"other.near"}, {asset:"other"}]) assert.throws(()=>recordIncomingCredit(sample(extra),receipt,dir),/Conflicting/);
 assert.throws(()=>recordIncomingCredit(sample(),Buffer.from("changed receipt"),dir),/Receipt changed/);
 for(const amount of ["0","-1","1.1","01"])assert.throws(()=>recordIncomingCredit(sample({amount}),receipt,root()));
 assert.throws(()=>recordIncomingCredit(sample({settledAt:"2027-01-01T00:00:00Z"}),receipt,root()),/future/);
 assert.throws(()=>recordIncomingCredit(sample(),Buffer.alloc(0),root()),/receipt/);
});
test("duplicated settlement under another receipt cannot count twice; conflicting aliases refuse", () => {
 const dir=root();const credit=sample({intentHash:"intent-1"});recordIncomingCredit(credit,receipt,dir);
 assert.equal(recordIncomingCredit({...credit,source:{...credit.source,receiptId:"another"}},receipt,dir).created,false);
 assert.throws(()=>recordIncomingCredit({...credit,amount:"11",source:{...credit.source,receiptId:"another"}},receipt,dir),/Conflicting/);
 assert.throws(()=>recordIncomingCredit({...sample(),source:{issuer:"https://other.example",receiptId:"another"}},receipt,dir),/Possible duplicate/);
});
test("later provider history wins over the receipt and must agree on asset and amount", () => {
 const c=sample({correlationId:"operation-1",intentHash:"intent-1"});
 const execution={asset:c.asset,amount:c.amount,correlationId:"operation-1",intentHash:"intent-1"};
 assert.equal(additionalIncomingCredits([c],[execution],c.recipient).totals.size,0);
 for(const extra of [{asset:"other"},{amount:"11"}])assert.throws(()=>additionalIncomingCredits([c],[{...execution,...extra}],c.recipient),/conflict/);
 assert.throws(()=>additionalIncomingCredits([c],[],"other.near"),/recipient/);
 assert.throws(()=>additionalIncomingCredits([sample()],[execution],c.recipient),/overlap/);
 assert.throws(()=>additionalIncomingCredits([sample({intentHash:"a"})],[{...execution,intentHash:null}],c.recipient),/overlap/);
});
test("malformed or tampered evidence refuses rather than silently dropping a credit", () => {
 const dir=root();recordIncomingCredit(sample(),receipt,dir);const folder=join(dir,readdirSync(dir)[0]!);const p=join(folder,readdirSync(folder)[0]!);
 const r=JSON.parse(readFileSync(p,"utf8"));r.credit.amount="1";writeFileSync(p,JSON.stringify(r));assert.throws(()=>readIncomingCredits("agent",dir),/integrity/);
 writeFileSync(p,"torn");assert.throws(()=>readIncomingCredits("agent",dir));
});
test("provider preference requires exact settled transfer terms and intent evidence", () => {
 const c=sample({correlationId:"operation-1"});const status={correlation_id:"operation-1",type:"transfer",status:"SUCCESS",updated_at:c.settledAt,details:{intent_hash:"intent-1",request:{recipient:c.recipient,asset:c.asset,amount:c.amount,confidential:true}}};
 assert.deepEqual(assertProviderCredit(c,status),{intentHash:"intent-1",settledAt:c.settledAt});
 for(const extra of [{status:"PROCESSING"},{type:"grant_issue"},{correlation_id:"another"}])assert.throws(()=>assertProviderCredit(c,{...status,...extra}),/exact/);
 for(const extra of [{recipient:"other.near"},{asset:"other"},{amount:"1"},{confidential:false}])assert.throws(()=>assertProviderCredit(c,{...status,details:{...status.details,request:{...status.details.request,...extra}}}),/exact/);
 assert.throws(()=>assertProviderCredit(c,{...status,details:{request:status.details.request}}),/exact/);
});

test("distinct settlements are additive while unknown provider overlap cannot be hidden", () => {
 const c=sample({correlationId:"op-a",intentHash:"intent-a"});
 const other={asset:c.asset,amount:"20000000",correlationId:"op-b",intentHash:"intent-b"};
 assert.equal(additionalIncomingCredits([c],[other],c.recipient).totals.get(c.asset),10000000n);
 assert.throws(()=>additionalIncomingCredits([c],[{...other,asset:null}],c.recipient),/overlap/);
 assert.throws(()=>additionalIncomingCredits([c],[{...other,amount:null}],c.recipient),/overlap/);
 assert.throws(()=>recordIncomingCredit(sample({evidence:"provider-status"}),receipt,root()),/Provider-backed/);
});

test("equal amounts and dates can represent two independently identified settlements", () => {
 const dir=root();const a=sample({intentHash:"intent-a"});const b=sample({intentHash:"intent-b",source:{issuer:a.source.issuer,receiptId:"another"}});
 recordIncomingCredit(a,receipt,dir);recordIncomingCredit(b,Buffer.from("a different settlement receipt"),dir);
 assert.equal(additionalIncomingCredits(readIncomingCredits("agent",dir),[],a.recipient).totals.get(a.asset),20000000n);
 const e={asset:a.asset,amount:a.amount,correlationId:"op-1",intentHash:"intent-b"};
 assert.throws(()=>additionalIncomingCredits([{...a,correlationId:"op-1"}],[e],a.recipient),/conflict/);
});
