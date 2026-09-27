import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";
const report = { status: "complete", pullRequestNumber: 7, localBranch: "main", localMainSha: "a".repeat(40), clean: true, todo: [], botReviewComplete: true, reason: "" };
function fixture() {
  let rejectExpiration, rejectFailure;
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; }); expiration.catch(() => {});
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; }); failure.catch(() => {});
  const session = { deadline: { expired: false, expiration, error: null }, client: { failure } };
  const handoff = { session, approval: { approvalTurnId: "ui-turn", approvedPlan: "Exact Plan" }, receipt: { id: 42 }, turnId: "implementation-turn" };
  const turn = { status: "completed", text: JSON.stringify(report), error: null };
  const evidence = { repository: "daiksud/test-codex", headSha: "b".repeat(40) };
  const calls = [];
  const options = {
    readTurn: async (value, turnId) => { assert.equal(value, session); assert.equal(turnId, handoff.turnId); calls.push("observe"); return turn; },
    auditDelivery: async (value, approval, receipt, parsed) => { assert.equal(value, session); assert.equal(approval, handoff.approval); assert.equal(receipt, handoff.receipt); assert.deepEqual(parsed, report); calls.push("audit"); return evidence; },
  };
  return { session, handoff, turn, evidence, calls, options,
    expire() { session.deadline.expired = true; session.deadline.error = new Error("deadline expired"); rejectExpiration(session.deadline.error); },
    fail() { rejectFailure(new Error("transport lost")); } };
}
function observe(fake) {
  assert.equal(typeof flow.observeIssueDelivery, "function");
  return flow.observeIssueDelivery(fake.handoff, fake.options);
}

test("observes one retained turn then returns report plus remote evidence without overall success flags", async () => {
  const fake = fixture();
  assert.deepEqual(await observe(fake), { turn: fake.turn, report, remoteEvidence: fake.evidence });
  assert.deepEqual(fake.calls, ["observe", "audit"]);
});

test("pending and failed reports return to caller without audit or starting another turn", async () => {
  for (const status of ["pending", "failed"]) {
    const fake = fixture(); const value = { ...report, status, todo: ["Remaining task"], reason: "Not done" }; fake.turn.text = JSON.stringify(value);
    assert.deepEqual(await observe(fake), { turn: fake.turn, report: value, remoteEvidence: null }); assert.deepEqual(fake.calls, ["observe"]);
  }
});

test("failed or interrupted SDK turns never parse reports or audit", async () => {
  for (const status of ["failed", "interrupted"]) {
    const fake = fixture(); fake.turn.status = status; fake.turn.error = status === "failed" ? { codexErrorInfo: "serverOverloaded" } : null;
    assert.deepEqual(await observe(fake), { turn: fake.turn, report: null, remoteEvidence: null }); assert.deepEqual(fake.calls, ["observe"]);
  }
});

test("malformed or incompletely qualified complete reports reject before audit", async () => {
  for (const value of ["not JSON", JSON.stringify({ ...report, clean: false }), JSON.stringify({ ...report, todo: ["Fix"] }), JSON.stringify({ ...report, botReviewComplete: false })]) {
    const fake = fixture(); fake.turn.text = value; await assert.rejects(observe(fake), /report|JSON|complete/i); assert.deepEqual(fake.calls, ["observe"]);
  }
});

test("an audit rejection is not hidden as a successful delivery", async () => {
  const fake = fixture(); fake.options.auditDelivery = async () => { throw new Error("remote audit failed"); };
  await assert.rejects(observe(fake), /remote audit failed/); assert.deepEqual(fake.calls, ["observe"]);
});

test("expired session observes and audits nothing", async () => {
  const fake = fixture(); fake.expire(); await assert.rejects(observe(fake), /deadline expired/); assert.deepEqual(fake.calls, []);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during observation or audit returns no success and executes no later stage`, async () => {
    for (const stage of ["readTurn", "auditDelivery"]) {
      const fake = fixture(); let finish;
      fake.options[stage] = async () => new Promise(resolve => { finish = resolve; });
      const operation = observe(fake); const rejected = assert.rejects(operation, stop === "deadline" ? /deadline expired/ : /transport lost/); rejected.catch(() => {});
      await setImmediate(); const before = fake.calls.slice();
      if (stop === "deadline") fake.expire(); else fake.fail(); await rejected;
      finish(stage === "readTurn" ? fake.turn : fake.evidence); await setImmediate(); assert.deepEqual(fake.calls, before);
    }
  });
}

test("retries transient remote audits with the same report and one turn observation until they pass", async () => {
  const fake = fixture(); let audits = 0, capturedReport; const delays = [];
  fake.options.waitBeforeRetry = async (delay, context) => { delays.push(delay); assert.equal(context.client, fake.session.client); assert.equal(context.deadline, fake.session.deadline); };
  fake.options.auditDelivery = async (session, approval, receipt, parsed) => {
    assert.equal(session, fake.session); assert.equal(approval, fake.handoff.approval); assert.equal(receipt, fake.handoff.receipt);
    if (capturedReport) assert.equal(parsed, capturedReport); else capturedReport = parsed;
    if (++audits <= 8) throw Object.assign(new Error("temporary read failure"), { retryable: true, delayMs: audits === 1 ? 7000 : null });
    return fake.evidence;
  };
  assert.deepEqual(await observe(fake), { turn: fake.turn, report, remoteEvidence: fake.evidence });
  assert.equal(audits, 9); assert.deepEqual(fake.calls, ["observe"]);
  assert.deepEqual(delays, [7000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during audit retry backoff never repeats the audit after a late wait`, async () => {
    const fake = fixture(); let audits = 0, finish;
    fake.options.auditDelivery = async () => { audits += 1; throw Object.assign(new Error("temporary read failure"), { retryable: true }); };
    fake.options.waitBeforeRetry = async () => new Promise(resolve => { finish = resolve; });
    const operation = observe(fake); const rejected = assert.rejects(operation, stop === "deadline" ? /deadline expired/ : /transport lost/); rejected.catch(() => {}); await setImmediate();
    assert.equal(typeof finish, "function", "transient audit failure must enter backoff");
    if (stop === "deadline") fake.expire(); else fake.fail(); finish(); await rejected; await setImmediate(); assert.equal(audits, 1); assert.deepEqual(fake.calls, ["observe"]);
  });
}
