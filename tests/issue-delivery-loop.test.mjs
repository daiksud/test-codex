import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";
function fixture(outcomes) {
  let rejectFailure, rejectExpiration;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; }); failure.catch(() => {});
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; }); expiration.catch(() => {});
  const session = { client: { failure }, deadline: { expired: false, expiration, error: null } };
  const handoff = { session, approval: { approvedPlan: "Exact Plan", approvalTurnId: "ui-turn" }, receipt: { id: 42 }, turnId: "initial-turn" };
  const calls = []; const evidence = { repository: "daiksud/test-codex", headSha: "b".repeat(40) };
  const options = {
    startDelivery: async value => { assert.equal(value, session); calls.push({ kind: "handoff" }); return handoff; },
    observeDelivery: async value => { assert.equal(value.session, session); assert.equal(value.approval, handoff.approval); assert.equal(value.receipt, handoff.receipt); calls.push({ kind: "observe", turnId: value.turnId }); const next = outcomes.shift(); assert.ok(next, "unexpected extra observation"); return { ...next, remoteEvidence: next.report?.status === "complete" ? evidence : null }; },
    continueDelivery: async (value, outcome) => { assert.equal(value.session, session); assert.equal(value.receipt, handoff.receipt); assert.equal(outcome.report.status, "pending"); const id = `pending-${calls.length}`; calls.push({ kind: "continue", id }); return id; },
    retryDelivery: async (value, outcome, options) => { assert.equal(value.session, session); assert.equal(value.receipt, handoff.receipt); assert.equal(outcome.turn.status, "failed"); assert.ok(options.delayMs >= 1000 && options.delayMs <= 60000); const id = `retry-${calls.length}`; calls.push({ kind: "retry", id, delay: options.delayMs }); return id; },
  };
  return { session, handoff, calls, evidence, options,
    expire() { session.deadline.expired = true; session.deadline.error = new Error("stopped"); rejectExpiration(session.deadline.error); },
    fail() { rejectFailure(new Error("stopped")); } };
}
const pending = () => ({ turn: { status: "completed" }, report: { status: "pending", todo: ["Continue self-review and handle CI"] } });
const complete = () => ({ turn: { status: "completed" }, report: { status: "complete", todo: [] } });
const transient = () => ({ turn: { status: "failed", error: { codexErrorInfo: "serverOverloaded" } }, report: null });
function run(fake) { assert.equal(typeof flow.runApprovedIssueSession, "function"); return flow.runApprovedIssueSession(fake.session, fake.options); }

test("multiple pending cycles keep the same approval/receipt and use each returned turn ID", async () => {
  const fake = fixture([pending(), pending(), complete()]);
  assert.deepEqual(await run(fake), { report: { status: "complete", todo: [] }, remoteEvidence: fake.evidence });
  assert.deepEqual(fake.calls.map(call => call.kind), ["handoff", "observe", "continue", "observe", "continue", "observe"]);
  const ids = fake.calls.filter(call => call.kind === "continue").map(call => call.id);
  assert.deepEqual(fake.calls.filter(call => call.kind === "observe").map(call => call.turnId), ["initial-turn", ...ids]);
});

test("confirmed transient failed turns retry without an arbitrary attempt cap", async () => {
  const fake = fixture([...Array.from({ length: 8 }, transient), complete()]);
  assert.equal((await run(fake)).remoteEvidence, fake.evidence);
  assert.equal(fake.calls.filter(call => call.kind === "handoff").length, 1);
  assert.equal(fake.calls.filter(call => call.kind === "retry").length, 8);
  assert.deepEqual(fake.calls.filter(call => call.kind === "retry").map(call => call.delay), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.deepEqual(fake.calls.filter(call => call.kind === "observe").map(call => call.turnId), ["initial-turn", ...fake.calls.filter(call => call.kind === "retry").map(call => call.id)]);
});

test("pending progress resets transient backoff for a later failed turn", async () => {
  const fake = fixture([transient(), pending(), transient(), complete()]); await run(fake);
  assert.deepEqual(fake.calls.filter(call => call.kind === "retry").map(call => call.delay), [1000, 1000]);
  assert.deepEqual(fake.calls.filter(call => call.kind === "observe").map(call => call.turnId), ["initial-turn", ...fake.calls.filter(call => call.kind === "retry" || call.kind === "continue").map(call => call.id)]);
});

test("permanent, unclassified, interrupted and reported failure exit without any new turn", async () => {
  for (const outcome of [
    { turn: { status: "failed", error: { codexErrorInfo: "contextWindowExceeded" } }, report: null },
    { turn: { status: "failed", error: null }, report: null }, { turn: { status: "interrupted" }, report: null },
    { turn: { status: "completed" }, report: { status: "failed", reason: "Cannot complete within constraints" } },
  ]) { const fake = fixture([outcome]); await assert.rejects(run(fake), /failed|interrupted|failure|delivery/i); assert.deepEqual(fake.calls.map(call => call.kind), ["handoff", "observe"]); }
});

test("complete without remote evidence and remote-audit errors never produce success", async () => {
  const fake = fixture([]); fake.options.observeDelivery = async () => ({ ...complete(), remoteEvidence: null });
  await assert.rejects(run(fake), /evidence|audit/i);
  const failed = fixture([]); failed.options.observeDelivery = async () => { throw new Error("remote audit failed"); };
  await assert.rejects(run(failed), /remote audit failed/); assert.equal(failed.calls.filter(call => call.kind === "continue" || call.kind === "retry").length, 0);
});

test("ambiguous start failures from initial, pending and retry helpers are not replayed", async () => {
  for (const stage of ["startDelivery", "continueDelivery", "retryDelivery"]) {
    const fake = fixture(stage === "continueDelivery" ? [pending()] : [transient()]); let count = 0;
    fake.options[stage] = async () => { count += 1; throw new Error("start outcome unknown"); };
    await assert.rejects(run(fake), /outcome unknown/); assert.equal(count, 1);
  }
});

test("expiry before session loop invokes no helper", async () => {
  const fake = fixture([complete()]); fake.expire(); await assert.rejects(run(fake), /stopped/); assert.equal(fake.calls.length, 0);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during any loop stage prevents late callbacks from advancing`, async () => {
    for (const stage of ["startDelivery", "observeDelivery", "continueDelivery", "retryDelivery"]) {
      const fake = fixture(stage === "retryDelivery" ? [transient()] : [pending()]); let finish;
      fake.options[stage] = async () => new Promise(resolve => { finish = resolve; });
      const operation = run(fake); const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {}); await setImmediate(); const before = fake.calls.slice();
      if (stop === "deadline") fake.expire(); else fake.fail();
      finish(stage === "startDelivery" ? fake.handoff : stage === "observeDelivery" ? pending() : "late-turn");
      await rejected; await setImmediate(); assert.deepEqual(fake.calls, before);
    }
  });
}
