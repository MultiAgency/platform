import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertDryGrantUses, memberName, syntax, walk } from "./fixtures/source-analysis.mjs";

/**
 * Every money action leaves through one door: `dispatch` in src/agent.ts. Execution calls pass through
 * its module-private `submitClaimed` → `send`; the provider's keyless cancellation is claimed and sent
 * in the dispatch-only cancellation branch. Anything else reaching a grant must be a dry quote. A new send path
 * fails here before it can skip the checks `dispatch` runs.
 */

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
const sources = files("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("only src/agent.ts accesses the grant-client factory", () => {
  const uses: string[] = [];
  for (const source of sources) walk(syntax(source.text), node => {
    if (memberName(node) === "forGrant") uses.push(source.path);
  });
  assert.deepEqual(uses, ["src/agent.ts"]);
});

test("outside src/agent.ts, the grant factory is used only for explicit dry quotes", () => {
  let uses = 0;
  for (const source of sources.filter(s => s.path !== "src/agent.ts")) {
    try { uses += assertDryGrantUses(source.text); }
    catch (error) { throw new Error(`${source.path}: ${error}`); }
  }
  assert.ok(uses > 0, "the quote site moved: update this test");
});

test("inside src/agent.ts, execution methods are called only from send", () => {
  const text = sources.find((s) => s.path === "src/agent.ts")!.text;
  const outside: string[] = [];
  walk(syntax(text), (node, parents) => {
    if (!["swap", "transfer", "shield", "unshield", "withdraw"].includes(memberName(node) ?? "")) return;
    const owner = [...parents].reverse().find(parent => parent.type === "FunctionDeclaration");
    if (owner?.id?.name !== "send") outside.push(memberName(node)!);
  });
  assert.deepEqual(outside, []);
  // The permit is module-private and passed by dispatch alone.
  assert.equal(text.match(/FIRST_SUBMISSION/g)?.length, 3, "declared, checked in send, passed once by dispatch");
  assert.equal(text.match(/\bsend\([^)]*FIRST_SUBMISSION\b[^)]*\)/g)?.length, 1);
  assert.match(text, /const FIRST_SUBMISSION = Symbol\(/);
  assert.doesNotMatch(text, /export\s+(const|let)\s+FIRST_SUBMISSION/);
});

const MONEY = ["swap", "transfer", "shield", "unshield", "withdraw", "placeLimitOrder", "cancelLimitOrder", "forGrant"];
const enclosingFunction = (parents: any[]) => [...parents].reverse().find(p => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(p.type));

test("the permitted send is called once inside a private helper reached only through dispatch", () => {
  const text = sources.find((s) => s.path === "src/agent.ts")!.text;
  const permitted: (string | undefined)[] = [];
  walk(syntax(text), (node, parents) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "send") return;
    if (!node.arguments.some((a: any) => a.type === "Identifier" && a.name === "FIRST_SUBMISSION")) return;
    permitted.push(enclosingFunction(parents)?.id?.name);
  });
  assert.deepEqual(permitted, ["submitClaimed"]);
  const callers: (string | undefined)[] = [];
  walk(syntax(text), (node, parents) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "submitClaimed")
      callers.push(enclosingFunction(parents)?.id?.name);
  });
  assert.deepEqual(callers.sort(), ["dispatch", "dispatchLimitOrder"].sort());
  assert.doesNotMatch(text, /export\s+(?:async\s+)?function\s+submitClaimed/);
});

test("the provider cancellation POST is reachable only through dispatch's claimed branch", () => {
  const text = sources.find(s => s.path === "src/agent.ts")!.text;
  const callers: (string | undefined)[] = [];
  walk(syntax(text), (node, parents) => {
    if (node.type === "CallExpression" && memberName(node.callee) === "cancelLimitOrder")
      callers.push(enclosingFunction(parents)?.id?.name);
  });
  assert.deepEqual(callers, ["dispatchLimitOrderCancellation"]);
  assert.match(text, /claimOrderCancellation\(proposalId, placed\.orderId\)/);
  assert.match(text, /claimSubmission\(key, request\)/);
  assert.match(text, /return dispatchLimitOrderCancellation\(lock, action\.request\.proposalId\)/);
});

// Known destructurings of a same-named field that is not a grant client method, each with its reason.
const NOT_GRANT = new Map([["src/owner-requests.ts:policyChange:swap", "a PolicyChanges field (the policy's swap rules), not a grant method"]]);

test("money methods and the grant factory are never taken out of their object by destructuring", () => {
  const found: string[] = [];
  for (const source of sources) walk(syntax(source.text), (node, parents) => {
    if (node.type !== "ObjectPattern") return;
    for (const property of node.properties) {
      const key = property.type === "ObjectProperty" ? (property.key.type === "Identifier" ? property.key.name : property.key.type === "StringLiteral" ? property.key.value : undefined) : undefined;
      const site = `${source.path}:${enclosingFunction([...parents, node])?.id?.name ?? "(module)"}:${key}`;
      if (key && MONEY.includes(key) && !NOT_GRANT.has(site)) found.push(site);
    }
  });
  assert.deepEqual(found, []);
});
