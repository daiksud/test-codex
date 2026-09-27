import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";
function fixture() {
  let rejectExpiration, rejectFailure;
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; }); expiration.catch(() => {});
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; }); failure.catch(() => {});
  const session = { threadId: "same-thread", deadline: { expired: false, expiration, error: null }, client: { failure } };
  const approval = { approvedPlan: "Edited Plan", approvalTurnId: "ui-turn" };
  const receipt = { id: 42, approvedPlan: approval.approvedPlan };
  const calls = [];
  const options = {
    waitForApproval: async value => { assert.equal(value, session); calls.push("approval"); return approval; },
    postPlan: async (value, accepted) => { assert.equal(value, session); assert.equal(accepted, approval); calls.push("publication"); return receipt; },
    startImplementation: async (value, accepted, published) => { assert.equal(value, session); assert.equal(accepted, approval); assert.equal(published, receipt); calls.push("implementation"); return "implementation-turn"; },
  };
  return { session, approval, receipt, calls, options,
    expire() { session.deadline.expired = true; session.deadline.error = new Error("deadline expired"); rejectExpiration(session.deadline.error); },
    fail() { rejectFailure(new Error("transport lost")); } };
}
function handoff(fake) {
  assert.equal(typeof flow.startApprovedIssueDelivery, "function");
  return flow.startApprovedIssueDelivery(fake.session, fake.options);
}

test("hands off the retained session only in approval, publication, implementation order", async () => {
  const fake = fixture();
  assert.deepEqual(await handoff(fake), { session: fake.session, approval: fake.approval, receipt: fake.receipt, turnId: "implementation-turn" });
  assert.deepEqual(fake.calls, ["approval", "publication", "implementation"]);
});

test("does not start implementation while approved Plan publication is pending", async () => {
  const fake = fixture(); let finish;
  fake.options.postPlan = async (session, approval) => { assert.equal(session, fake.session); assert.equal(approval, fake.approval); fake.calls.push("publication"); return new Promise(resolve => { finish = resolve; }); };
  const operation = handoff(fake); await setImmediate();
  assert.deepEqual(fake.calls, ["approval", "publication"]);
  finish(fake.receipt); await operation; assert.deepEqual(fake.calls, ["approval", "publication", "implementation"]);
});

test("approval and publication failures prevent every later operation", async () => {
  for (const failed of ["waitForApproval", "postPlan"]) {
    const fake = fixture(); fake.options[failed] = async () => { throw new Error("stage failed"); };
    await assert.rejects(handoff(fake), /stage failed/);
    assert.deepEqual(fake.calls, failed === "waitForApproval" ? [] : ["approval"]);
  }
});

test("an ambiguous implementation-start rejection is never replayed", async () => {
  const fake = fixture(); let starts = 0;
  fake.options.startImplementation = async () => { starts += 1; throw new Error("start outcome unknown"); };
  await assert.rejects(handoff(fake), /outcome unknown/); assert.equal(starts, 1);
});

test("an expired Issue starts no approval wait or later operation", async () => {
  const fake = fixture(); fake.expire(); await assert.rejects(handoff(fake), /deadline expired/); assert.deepEqual(fake.calls, []);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} prevents later stages even when a pending stage finishes later`, async () => {
    for (const stage of ["waitForApproval", "postPlan", "startImplementation"]) {
      const fake = fixture(); let finish;
      fake.options[stage] = async () => new Promise(resolve => { finish = resolve; });
      const operation = handoff(fake); const rejected = assert.rejects(operation, stop === "deadline" ? /deadline expired/ : /transport lost/); rejected.catch(() => {});
      await setImmediate(); const before = fake.calls.slice();
      if (stop === "deadline") fake.expire(); else fake.fail(); await rejected;
      finish(stage === "waitForApproval" ? fake.approval : stage === "postPlan" ? fake.receipt : "late-turn");
      await setImmediate(); assert.deepEqual(fake.calls, before);
    }
  });
}
