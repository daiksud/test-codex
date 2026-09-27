import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const threadId = "issue-thread";
const turnId = "initial-plan-turn";
const approvalTurnId = "ui-approval-turn";
const prefix = "PLEASE IMPLEMENT THIS PLAN:\n";

function message(text, options = {}) {
  return {
    method: options.method ?? "item/started",
    params: {
      threadId: options.threadId ?? threadId,
      turnId: options.turnId ?? approvalTurnId,
      item: { type: options.type ?? "userMessage", content: [{ type: "text", text }] },
    },
  };
}

function completed(id = approvalTurnId, status = "interrupted", eventThreadId = threadId) {
  return { method: "turn/completed", params: { threadId: eventThreadId, turn: { id, status } } };
}

function fixture(events = [], blockInterrupt = false, allowWait = false) {
  const requests = [];
  const waiters = [];
  let rejectFailure;
  let rejectExpiration;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  failure.catch(() => {});
  expiration.catch(() => {});
  const deadline = { expiration, expired: false, error: null };
  const client = {
    failure,
    request: async (method, params) => {
      requests.push({ method, params });
      assert.equal(method, "turn/interrupt");
      if (blockInterrupt) return new Promise(() => {});
      return {};
    },
    nextEvent: () => events.length ? Promise.resolve(events.shift()) : allowWait ?
      new Promise(resolve => waiters.push(resolve)) :
      Promise.reject(new Error("unexpected end of event stream")),
  };
  return {
    session: { client, deadline, threadId, turnId }, requests,
    emit(event) {
      const resolve = waiters.shift();
      if (resolve) resolve(event);
      else events.push(event);
    },
    fail: rejectFailure,
    expire() {
      deadline.expired = true;
      deadline.error = new Error("Issue deadline expired");
      rejectExpiration(deadline.error);
    },
  };
}

function waitForApproval(session) {
  assert.equal(typeof issueFlow.waitForIssuePlanApproval, "function");
  return issueFlow.waitForIssuePlanApproval(session);
}

test("accepts only a fresh same-thread UI Plan message and preserves exact edits", async () => {
  const approvedPlan = "編集済み計画\n\n1. Check boundary.\n";
  const fake = fixture([
    message(prefix + "wrong thread", { threadId: "other-thread" }),
    message(prefix + "old turn", { turnId }),
    message(prefix + "agent text", { type: "agentMessage" }),
    message("Quoted " + prefix + "not approval"),
    message("Please explain the plan."),
    completed("ordinary-turn", "completed"),
    message(prefix + approvedPlan),
    message(prefix + approvedPlan, { method: "item/completed" }),
    completed("unrelated-turn"),
    completed(),
  ]);
  assert.deepEqual(await waitForApproval(fake.session), { approvedPlan, approvalTurnId });
  assert.deepEqual(fake.requests, [{
    method: "turn/interrupt", params: { threadId, turnId: approvalTurnId },
  }]);
});

test("does not release approval until its read-only turn has ended", async () => {
  const fake = fixture([message(prefix + "Concrete plan")], false, true);
  let released = false;
  const waiting = waitForApproval(fake.session).then(result => {
    released = true;
    return result;
  });
  waiting.catch(() => {});
  await setImmediate();
  assert.equal(fake.requests.length, 1);
  assert.equal(released, false);
  fake.emit(completed("other-turn"));
  await setImmediate();
  assert.equal(released, false);
  fake.emit(completed(approvalTurnId, "completed", "other-thread"));
  await setImmediate();
  assert.equal(released, false);
  fake.emit(completed(approvalTurnId, "completed"));
  assert.deepEqual(await waiting, { approvedPlan: "Concrete plan", approvalTurnId });
  assert.equal(fake.requests.length, 1);
});

test("rejects empty approved text and unsuccessful approval-turn completion", async () => {
  for (const events of [[message(prefix)], [message(prefix + "Plan"), completed(approvalTurnId, "failed")]]) {
    const fake = fixture(events);
    await assert.rejects(waitForApproval(fake.session), /empty|failed/);
  }
});

test("rejects file changes while approval is still protected", async () => {
  for (const beforeApproval of [true, false]) {
    const change = { method: "item/started", params: { threadId, turnId: approvalTurnId, item: { type: "fileChange" } } };
    const fake = fixture(beforeApproval ? [change] : [message(prefix + "Plan"), change]);
    await assert.rejects(waitForApproval(fake.session), /must not modify files/);
  }
});

for (const phase of ["waiting", "interrupt request", "terminal event"]) {
  for (const stop of ["deadline", "transport"]) {
    test(`${stop} rejects while ${phase} instead of releasing approval`, async () => {
      const fake = fixture(phase === "waiting" ? [] : [message(prefix + "Plan")], phase === "interrupt request", true);
      const waiting = waitForApproval(fake.session);
      const rejected = assert.rejects(waiting, stop === "deadline" ? /deadline expired/ : /transport lost/);
      if (phase !== "waiting") {
        await setImmediate();
        assert.equal(fake.requests.length, 1);
      }
      if (stop === "deadline") fake.expire();
      else fake.fail(new Error("transport lost"));
      await rejected;
    });
  }
}

test("does not consume queued approval after the deadline already expired", async () => {
  const fake = fixture([message(prefix + "Plan"), completed()]);
  fake.expire();
  await assert.rejects(waitForApproval(fake.session), /deadline expired/);
  assert.equal(fake.requests.length, 0);
});
