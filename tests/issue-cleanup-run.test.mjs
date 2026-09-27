import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";

const repository = "daiksud/test-codex";
const threadId = "approved-thread";
const approval = { approvalTurnId: "ui-turn", approvedPlan: "Approved Plan" };
const receipt = {
  id: 42,
  url: `https://github.com/${repository}/issues/19#issuecomment-42`,
  repository,
  issueNumber: 19,
  threadId,
  ...approval,
};
const cleanupReport = {
  status: "failed",
  pullRequestNumber: 7,
  localBranch: "main",
  localMainSha: "a".repeat(40),
  clean: true,
  todo: [],
  botReviewComplete: false,
  reason: "Original delivery failed; local cleanup done",
};

function fixture() {
  const calls = [];
  let rejectExpiration;
  let rejectFailure;
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  expiration.catch(() => {});
  failure.catch(() => {});
  const session = {
    threadId,
    issue: { repository, number: 19 },
    client: { failure },
    deadline: { expired: false, expiration, error: null },
    deliveryContext: { approval, receipt, turnId: "failed-turn" },
  };
  const turn = { status: "completed", text: JSON.stringify(cleanupReport), error: null };
  const options = {
    quiesce: async value => {
      assert.equal(value, session);
      calls.push("quiesce");
      return { interruptRequestedTurnId: null };
    },
    startCleanup: async (handoff, reason) => {
      assert.equal(handoff.session, session);
      assert.equal(handoff.approval, approval);
      assert.equal(handoff.receipt, receipt);
      assert.equal(reason, "Original delivery failed");
      calls.push("start");
      return "cleanup-turn";
    },
    readTurn: async (value, turnId) => {
      assert.equal(value, session);
      assert.equal(turnId, "cleanup-turn");
      calls.push("observe");
      return turn;
    },
  };
  return {
    session,
    turn,
    calls,
    options,
    expire() {
      session.deadline.expired = true;
      session.deadline.error = new Error("stopped");
      rejectExpiration(session.deadline.error);
    },
    fail() { rejectFailure(new Error("stopped")); },
  };
}
function run(fake) {
  assert.equal(typeof flow.runIssueFailureCleanup, "function");
  return flow.runIssueFailureCleanup(fake.session, "Original delivery failed", fake.options);
}

test("failure cleanup is observed only after quiescence and returns failed self-reported local facts", async () => {
  const fake = fixture();
  assert.deepEqual(await run(fake), { status: "failed", cleanupReport });
  assert.deepEqual(fake.calls, ["quiesce", "start", "observe"]);
});

test("quiesce or ambiguous cleanup startup failure is never replayed or observed", async () => {
  for (const stage of ["quiesce", "startCleanup"]) {
    const fake = fixture();
    let attempts = 0;
    fake.options[stage] = async () => {
      attempts += 1;
      throw new Error("outcome unknown");
    };
    await assert.rejects(run(fake), /outcome unknown/);
    assert.equal(attempts, 1);
    assert.equal(fake.calls.includes("observe"), false);
  }
});

test("unapproved, invalid-receipt or expired cleanup invokes no helper", async () => {
  for (const mode of ["unapproved", "receipt", "expired"]) {
    const fake = fixture();
    if (mode === "unapproved") delete fake.session.deliveryContext;
    if (mode === "receipt") fake.session.deliveryContext.receipt = { ...receipt, approvedPlan: "unapproved" };
    if (mode === "expired") fake.expire();
    await assert.rejects(run(fake), /context|receipt|publication|stopped/i);
    assert.deepEqual(fake.calls, []);
  }
});

test("cleanup cannot report success, non-main, dirty state, invalid SHA or remaining cleanup ToDo", async () => {
  for (const change of [
    { status: "complete", botReviewComplete: true },
    { localBranch: "codex/issue-19" },
    { clean: false },
    { localMainSha: null },
    { todo: ["Cleanup remains"] },
  ]) {
    const fake = fixture();
    fake.turn.text = JSON.stringify({ ...cleanupReport, ...change });
    await assert.rejects(run(fake), /cleanup|failed|main|report/i);
    assert.deepEqual(fake.calls, ["quiesce", "start", "observe"]);
  }
});

test("failed, interrupted or malformed cleanup outcomes are not clean-up proof", async () => {
  for (const status of ["failed", "interrupted"]) {
    const fake = fixture();
    fake.turn.status = status;
    await assert.rejects(run(fake), /completed|cleanup|report/i);
  }
  const fake = fixture();
  fake.turn.text = "not JSON";
  await assert.rejects(run(fake), /JSON|report/i);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during cleanup stages cannot accept a late result`, async () => {
    for (const stage of ["quiesce", "startCleanup", "readTurn"]) {
      const fake = fixture();
      let finish;
      fake.options[stage] = async () => new Promise(resolve => { finish = resolve; });
      const operation = run(fake);
      const rejected = assert.rejects(operation, /stopped/);
      rejected.catch(() => {});
      await setImmediate();
      const before = fake.calls.slice();
      if (stop === "deadline") fake.expire();
      else fake.fail();
      finish(stage === "readTurn" ? fake.turn : stage === "startCleanup" ? "late-cleanup-turn" : {});
      await rejected;
      await setImmediate();
      assert.deepEqual(fake.calls, before);
    }
  });
}

test("invalid cleanup reasons cannot quiesce or interrupt a turn", async () => {
  assert.equal(typeof flow.runIssueFailureCleanup, "function");
  const fake = fixture();
  for (const reason of ["", "  ", null, { toString: () => "reason" }]) {
    await assert.rejects(flow.runIssueFailureCleanup(fake.session, reason, fake.options), /reason/i);
  }
  assert.deepEqual(fake.calls, []);
});
