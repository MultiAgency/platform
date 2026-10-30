import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../src/gateway/config.js";

test("gateway approve-only survives an instance file requesting execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "executor-review-"));
  try {
    const envFile = join(dir, "instance.env");
    writeFileSync(envFile, "EXECUTOR=on\n");
    const env = childEnv({ name: "fixture", owner: "owner.near", port: 4001, executor: false, envFile });
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const {executes,saveEnv}=await import('./src/env.ts'); console.log(String(executes())); saveEnv({EXECUTOR:'on'}); console.log(String(executes()));`], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "false\nfalse");
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

const { paymentAssets } = await import(new URL("../web/src/features/payables/payment-assets.ts", import.meta.url).href);
const { ASSETS } = await import("../src/policy.js");
const book = [{ asset: ASSETS.USDC, symbol: "USDC", decimals: 6, public: "0", confidential: "0", usd: 0, price: 1 }];
test("payout choices exclude unsupported assets even when wNEAR is first", () => {
  const all = [{ ...book[0], asset: ASSETS.wNEAR, symbol: "wNEAR" }, ...book];
  for (const label of ["payout", "invoices"]) assert.deepEqual(paymentAssets(all, label), book);
  assert.deepEqual(paymentAssets(all, "treasury"), all);
});
