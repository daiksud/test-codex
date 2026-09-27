import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const threadId = "issue-thread";
const turnId = "implementation-turn";

function item(text, phase = "final_answer", other = {}) {
  return { method: "item/completed", params: {
    threadId, turnId, item: { type: "agentMessage", text, phase }, ...other,
  } };
}

function terminal(status = "completed", error = null, other = {}) {
  return { method: "turn/completed", params: {
    threadId, turn: { id: turnId, status, ...(error ? { error } : {}) }, ...other,
  } };
}

function fixture(events, allowWait = false) {
  let rejectFailure;
  let rejectExpiration;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  failure.catch(() => {});
  expiration.catch(() => {});
  const waiters = [];
  let reads = 0;
  const deadline = { expiration, expired: false, error: null };
  return {
    session: { threadId, deadline, client: {
      failure,
      nextEvent() {
        reads += 1;
        if (events.length) return Promise.resolve(events.shift());
        if (!allowWait) return Promise.reject(new Error("Unexpected event-stream end"));
        return new Promise(resolve => waiters.push(resolve));
      },
    } },
    get reads() { return reads; },
    emit(event) { const resolve = waiters.shift(); if (resolve) resolve(event); else events.push(event); },
    fail: rejectFailure,
    expire() {
      deadline.expired = true;
      deadline.error = new Error("Issue deadline expired");
      rejectExpiration(deadline.error);
    },
  };
}

function read(session, id = turnId) {
  assert.equal(typeof issueFlow.readIssueImplementationTurn, "function");
  return issueFlow.readIssueImplementationTurn(session, id);
}

test("observes only its implementation turn and prefers the final answer", async () => {
  const fake = fixture([
    item("other-thread", "final_answer", { threadId: "other" }),
    item("other-turn", "final_answer", { turnId: "other" }),
    item("Working", "commentary"),
    { method: "item/started", params: { threadId, turnId, item: { type: "fileChange", changes: [] } } },
    item("Delivery evidence", "final_answer"),
    item("Later commentary", "commentary"),
    terminal("completed", null, { threadId: "other" }),
    terminal("completed", null, { turn: { id: "other", status: "completed" } }),
    terminal(),
  ]);
  assert.deepEqual(await read(fake.session), { status: "completed", text: "Delivery evidence", error: null });
});

test("waits for the matching terminal after a final answer", async () => {
  const fake = fixture([item("Final evidence")], true);
  let returned = false;
  const result = read(fake.session).then(value => { returned = true; return value; });
  result.catch(() => {});
  await setImmediate();
  assert.equal(fake.reads, 2);
  assert.equal(returned, false);
  fake.emit(terminal());
  assert.equal((await result).text, "Final evidence");
});

test("a completed turn without a final answer is not a delivery success assertion", async () => {
  for (const events of [[terminal()], [item("Still waiting for CI", "commentary"), terminal()]]) {
    const fake = fixture(events);
    assert.deepEqual(await read(fake.session), { status: "completed", text: null, error: null });
  }
});

test("retains failed and interrupted statuses and terminal error details", async () => {
  const error = { message: "Temporary service failure", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } };
  for (const status of ["failed", "interrupted"]) {
    const fake = fixture([
      { method: "error", params: { threadId, turnId, error: { message: "older error", codexErrorInfo: "other" } } },
      terminal(status, status === "failed" ? error : null),
    ]);
    const result = await read(fake.session);
    assert.equal(result.status, status);
    assert.equal(result.text, null);
    if (status === "failed") assert.deepEqual(result.error, error);
  }
});

test("keeps notification errors when a failed terminal omits details", async () => {
  const error = { message: "Temporary failure", codexErrorInfo: "serverOverloaded" };
  const fake = fixture([{ method: "error", params: { threadId, turnId, error } }, terminal("failed")]);
  assert.deepEqual(await read(fake.session), { status: "failed", text: null, error });
});

test("does not reuse an earlier turn's final answer or error", async () => {
  const fake = fixture([
    item("First final"), terminal(),
    { method: "error", params: { threadId, turnId, error: { message: "stale" } } },
    terminal("completed", null, { turn: { id: "second-turn", status: "completed" } }),
  ]);
  assert.equal((await read(fake.session)).text, "First final");
  assert.deepEqual(await read(fake.session, "second-turn"), { status: "completed", text: null, error: null });
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} stops a pending result observation`, async () => {
    const fake = fixture([], true);
    const waiting = read(fake.session);
    const rejected = assert.rejects(waiting, stop === "deadline" ? /deadline expired/ : /transport lost/);
    rejected.catch(() => {});
    await setImmediate();
    assert.equal(fake.reads, 1);
    if (stop === "deadline") fake.expire();
    else fake.fail(new Error("transport lost"));
    await rejected;
  });
}

test("does not consume queued success after expiry", async () => {
  const fake = fixture([item("Final"), terminal()]);
  fake.expire();
  await assert.rejects(read(fake.session), /deadline expired/);
  assert.equal(fake.reads, 0);
});
