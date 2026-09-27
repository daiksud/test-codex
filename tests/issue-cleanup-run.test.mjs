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
      throw Object.assign(new Error("outcome unknown"), { retryable: true, codexErrorInfo: "serverOverloaded" });
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

test("confirmed transient cleanup turns retry beyond three attempts with fresh inspection and returned IDs", async () => {
  const fake = fixture();
  let starts = 0;
  const delays = [];
  fake.options.quiesce = async value => {
    assert.equal(value, fake.session);
    assert.equal(value.deliveryContext.turnId, starts ? `cleanup-${starts}` : "failed-turn");
    fake.calls.push("quiesce");
  };
  fake.options.startCleanup = async (handoff, reason) => {
    assert.equal(fake.calls.at(-1), "quiesce");
    assert.equal(handoff.session, fake.session);
    assert.equal(handoff.approval, approval);
    assert.equal(handoff.receipt, receipt);
    assert.equal(reason, "Original delivery failed");
    fake.calls.push("start");
    const id = `cleanup-${++starts}`;
    fake.session.deliveryContext.turnId = id;
    return id;
  };
  fake.options.readTurn = async (value, id) => {
    assert.equal(value, fake.session);
    assert.equal(id, `cleanup-${starts}`);
    fake.calls.push("observe");
    return starts <= 8 ? { status: "failed", error: { codexErrorInfo: starts % 2 ? "serverOverloaded" : { httpConnectionFailed: { httpStatusCode: 503 } } } } : fake.turn;
  };
  fake.options.waitBeforeRetry = async (delay, options) => {
    assert.equal(fake.calls.at(-1), "observe");
    assert.equal(options.client, fake.session.client);
    assert.equal(options.deadline, fake.session.deadline);
    delays.push(delay); fake.calls.push("wait");
  };
  assert.deepEqual(await run(fake), { status: "failed", cleanupReport });
  assert.equal(starts, 9);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.deepEqual(fake.calls, [...Array.from({ length: 8 }, () => ["quiesce", "start", "observe", "wait"]).flat(), "quiesce", "start", "observe"]);
});

test("cleanup permanent, unclassified, interrupted or read failures are not retried", async () => {
  for (const [status, info] of [
    ["failed", null], ["failed", "contextWindowExceeded"],
    ["failed", { httpConnectionFailed: { httpStatusCode: 400 } }],
    ["failed", { responseTooManyFailedAttempts: { httpStatusCode: null } }],
    ["interrupted", "serverOverloaded"],
  ]) {
    const fake = fixture(); fake.turn.status = status; fake.turn.error = { codexErrorInfo: info };
    fake.options.waitBeforeRetry = async () => assert.fail("must not retry this failure");
    await assert.rejects(run(fake), /completed|report/i);
    assert.deepEqual(fake.calls, ["quiesce", "start", "observe"]);
  }
  const fake = fixture();
  fake.options.readTurn = async () => { throw Object.assign(new Error("read outcome unknown"), { retryable: true }); };
  fake.options.waitBeforeRetry = async () => assert.fail("unknown read cannot authorize retry");
  await assert.rejects(run(fake), /read outcome unknown/);
  assert.deepEqual(fake.calls, ["quiesce", "start"]);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during cleanup retry backoff prevents a late cleanup restart`, async () => {
    const fake = fixture(); fake.turn.status = "failed"; fake.turn.error = { codexErrorInfo: "internalServerError" };
    let finish, enter;
    const waiting = new Promise(resolve => { enter = resolve; });
    fake.options.waitBeforeRetry = async () => new Promise(resolve => { finish = resolve; enter(); });
    const operation = run(fake);
    const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {});
    await Promise.race([waiting, operation.then(() => { throw new Error("cleanup finished without waiting"); }, () => { throw new Error("cleanup failed without entering retry backoff"); })]);
    const before = fake.calls.slice();
    if (stop === "deadline") fake.expire(); else fake.fail();
    await rejected;
    finish(); await setImmediate();
    assert.deepEqual(fake.calls, before);
  });
}
