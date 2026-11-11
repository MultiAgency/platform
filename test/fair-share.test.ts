import assert from "node:assert/strict";
import { test } from "node:test";
import { fairShare } from "../src/gateway/fair-share.js";

const HOUR = 3_600_000;
/** Sends `n` requests for `org` at `at`, and returns how many were allowed. */
const send = (share: ReturnType<typeof fairShare>, org: string | null, n: number, at: number, limit = 100) => {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (share.allow("cred", org, at, limit).allowed) allowed++;
  return allowed;
};

test("one Organization alone may use the whole budget: no slice is kept back for anyone", () => {
  const share = fairShare();
  assert.equal(send(share, "a", 101, 0), 100);
  assert.deepEqual(share.allow("cred", "a", 1, 100), { allowed: false, reason: "limit", retryAfterSeconds: 3600 });
});

test("a busy Organization can't use the slices owed to others seen this hour", () => {
  const share = fairShare();
  assert.equal(send(share, "b", 1, 0), 1, "b is seen, and has used 1 of its 5");
  // a gets everything except what is still owed to b (4 of b's 5).
  assert.equal(send(share, "a", 100, 1), 95);
  const refused = share.allow("cred", "a", 2, 100);
  assert.deepEqual([refused.allowed, refused.allowed ? null : refused.reason], [false, "fair_share"]);
  // b still gets its slice...
  assert.equal(send(share, "b", 4, 3), 4);
  // ...and nothing more once the hour is full.
  assert.equal(send(share, "b", 1, 4), 0);
});

test("a newcomer refused at the limit is still seen, so its slice is kept when the busy Organization refills the hour", () => {
  const share = fairShare();
  assert.equal(send(share, "a", 100, 0), 100);
  assert.equal(share.allow("cred", "c", HOUR / 2, 100).allowed, false, "the hour is full, but c is now seen");
  // a's requests leave the hour; a refills it, but c's slice is kept back for the hour c was seen in.
  assert.equal(send(share, "a", 100, HOUR + 1), 95);
  assert.equal(send(share, "c", 5, HOUR + 2), 5, "c gets its slice");
});

test("the slices kept back never exceed half the budget, however many Organizations are seen", () => {
  const share = fairShare();
  for (let i = 0; i < 40; i++) share.allow("cred", `o${i}`, 0, 100);
  // 40 seen, each owed 4 more (160), capped at 50: a busy one gets 100 - 40 - 50 = 10.
  assert.equal(send(share, "busy", 100, 1), 10);
});

test("calls naming no Organization count toward the hour but have no slice", () => {
  const share = fairShare();
  assert.equal(send(share, "b", 1, 0), 1);
  assert.equal(send(share, null, 100, 1), 95);
  assert.equal(send(share, "b", 4, 2), 4);
});

test("each credential has its own hour", () => {
  const share = fairShare();
  assert.equal(send(share, "a", 100, 0), 100);
  assert.equal(share.allow("other", "a", 0, 100).allowed, true);
});
