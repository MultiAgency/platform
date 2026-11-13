import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const command = fileURLToPath(new URL("../src/record-incoming-credit.ts", import.meta.url));
const loader = import.meta.resolve("tsx"), sdk = import.meta.resolve("@near-intents-agent-api/sdk");
const agent = "a".repeat(64);
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), "incoming-cli-"));
 writeFileSync(join(dir,"credit.json"),JSON.stringify({agent,recipient:"wallet.near",asset:"nep141:usdc",amount:"1000000",settledAt:"2026-01-01T00:00:00Z",source:{issuer:"https://receipt.example",receiptId:"fixture:1"}}));
 writeFileSync(join(dir,"receipt.txt"),"Synthetic executed funding receipt");
 writeFileSync(join(dir,"provider.mjs"),`import {AgentApi} from ${JSON.stringify(sdk)};AgentApi.prototype.getAgent=async()=>({wallet:{near_account_id:'wallet.near'}});`);
 return {dir,run:(extra:string[])=>spawnSync(process.execPath,["--import",loader,"--import",join(dir,"provider.mjs"),command,"--credit",join(dir,"credit.json"),"--receipt",join(dir,"receipt.txt"),"--recorded-by","fixture operator",...extra],{cwd:dir,env:{...process.env,AGENT_ID:agent,ENV_FILE:".env"},encoding:"utf8",timeout:15000})};
}
test("CLI requires stopped-executor and receipt attestations; an identical import remains accounting-only",()=>{
 const f=fixture();
 assert.notEqual(f.run(["--attest-receipt"]).status,0);
 assert.equal(existsSync(join(f.dir,".evidence")),false);
 assert.notEqual(f.run(["--executor-stopped"]).status,0);
 const first=f.run(["--executor-stopped","--attest-receipt"]);assert.equal(first.status,0,first.stderr);
 assert.deepEqual(JSON.parse(first.stdout),{created:true,evidence:"operator-receipt",accountingOnly:true,notice:"Recorded funding evidence, not a new payment or an execution-journal repair. Re-read books before releasing any proposal hold."});
 const again=f.run(["--executor-stopped","--attest-receipt"]);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).created,false);
});
test("CLI refuses unresolved preparations without resolving or editing the execution journal",()=>{
 const f=fixture();mkdirSync(join(f.dir,".ops"));const file=join(f.dir,".ops",`${agent}.jsonl`);
 const journal=JSON.stringify({at:"2026-01-01T00:00:00Z",idempotencyKey:"original-request",kind:"proposal",method:"transfer",journalVersion:2,request:{asset:"nep141:usdc",amount:"1",recipient:"other.near",confidential:true}})+"\n";
 writeFileSync(file,journal);
 const result=f.run(["--executor-stopped","--attest-receipt"]);assert.notEqual(result.status,0);assert.match(result.stderr,/no proven outcome/);
 assert.equal(readFileSync(file,"utf8"),journal);assert.equal(existsSync(join(f.dir,".evidence")),false);
});
