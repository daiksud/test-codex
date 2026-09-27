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
const owned = { id: "owned-turn", status: "inProgress" };
function page(data, nextCursor = null) { return { data, nextCursor }; }

function fixture(pages) {
  const calls = [];
  const waits = [];
  let rejectExpiration;
  let rejectFailure;
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  expiration.catch(() => {});
  failure.catch(() => {});
  const client = {
    failure,
    implementationProfile: "codex_issue_workspace_fixture",
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/turns/list") {
        assert.equal(params.threadId, threadId);
        assert.equal(params.itemsView, "notLoaded");
        assert.equal(params.sortDirection, "desc");
        assert.equal(params.limit, 100);
        const value = pages.shift();
        assert.notEqual(value, undefined, "unexpected extra turn-state poll");
        return value;
      }
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected ${method}`);
    },
  };
  const session = {
    issue: { repository, number: 19 },
    threadId,
    client,
    deadline: { expired: false, expiration, error: null },
    deliveryContext: { approval, receipt, turnId: owned.id },
  };
  const options = {
    waitBeforePoll: async (delay, context) => {
      assert.equal(context.client, client);
      assert.equal(context.deadline, session.deadline);
      waits.push(delay);
    },
  };
  return {
    session,
    options,
    calls,
    waits,
    expire() {
      session.deadline.expired = true;
      session.deadline.error = new Error("stopped");
      rejectExpiration(session.deadline.error);
    },
    fail() { rejectFailure(new Error("stopped")); },
  };
}
function quiesce(fake) {
  assert.equal(typeof flow.quiesceIssueForCleanup, "function");
  return flow.quiesceIssueForCleanup(fake.session, fake.options);
}

test("terminal tracked turn allows cleanup without interruption", async () => {
  const fake = fixture([page([{ ...owned, status: "failed" }])]);
  assert.deepEqual(await quiesce(fake), { interruptRequestedTurnId: null });
  assert.deepEqual(fake.calls.map(call => call.method), ["thread/turns/list"]);
  assert.deepEqual(fake.waits, []);
});

test("confirmed active owned turn is interrupted once and polled until terminal", async () => {
  const fake = fixture([page([owned]), page([owned]), page([{ ...owned, status: "interrupted" }])]);
  assert.deepEqual(await quiesce(fake), { interruptRequestedTurnId: owned.id });
  assert.deepEqual(fake.calls.map(call => call.method), ["thread/turns/list", "turn/interrupt", "thread/turns/list", "thread/turns/list"]);
  assert.deepEqual(fake.calls[1].params, { threadId, turnId: owned.id });
  assert.deepEqual(fake.waits, [1000, 1000]);
});

test("unknown/null ID with active turn, other active ID, multiple active or missing tracked turn fail closed", async () => {
  for (const mode of ["null", "other", "multiple", "missing"]) {
    const fake = fixture([page(mode === "multiple" ? [owned, { id: "other", status: "inProgress" }] : mode === "missing" ? [] : [owned])]);
    if (mode === "null") fake.session.deliveryContext.turnId = null;
    if (mode === "other") fake.session.deliveryContext.turnId = "other";
    await assert.rejects(quiesce(fake), /owned|active|tracked|turn/i);
    assert.equal(fake.calls.some(call => call.method === "turn/interrupt"), false);
  }
});

test("unknown startup with no active turn is quiescent without inventing an owned ID", async () => {
  const fake = fixture([page([{ id: "old", status: "completed" }])]);
  fake.session.deliveryContext.turnId = null;
  assert.deepEqual(await quiesce(fake), { interruptRequestedTurnId: null });
});

test("paginated state is inspected completely before interrupting", async () => {
  const fake = fixture([page([{ id: "old", status: "completed" }], "next"), page([owned]), page([{ ...owned, status: "failed" }])]);
  await quiesce(fake);
  assert.equal(fake.calls[1].params.cursor, "next");
  assert.equal(fake.calls[2].method, "turn/interrupt");
});

test("ambiguous interrupt response is not replayed; only state is polled", async () => {
  const fake = fixture([page([owned]), page([owned]), page([{ ...owned, status: "interrupted" }])]);
  const original = fake.session.client.request;
  fake.session.client.request = async (method, params) => {
    if (method === "turn/interrupt") {
      fake.calls.push({ method, params });
      throw new Error("interrupt outcome unknown");
    }
    return original(method, params);
  };
  assert.deepEqual(await quiesce(fake), { interruptRequestedTurnId: owned.id });
  assert.equal(fake.calls.filter(call => call.method === "turn/interrupt").length, 1);
});

test("missing authority, invalid receipt or expired session performs no RPC", async () => {
  for (const mode of ["missing", "receipt", "expiry"]) {
    const fake = fixture([page([owned])]);
    if (mode === "missing") delete fake.session.deliveryContext;
    if (mode === "receipt") fake.session.deliveryContext.receipt = { ...receipt, approvedPlan: "not approved" };
    if (mode === "expiry") fake.expire();
    await assert.rejects(quiesce(fake), /receipt|publication|context|stopped/i);
    assert.equal(fake.calls.length, 0);
  }
});

test("malformed turn pages and unknown states cannot authorize interruption", async () => {
  for (const value of [null, page({}), page([{ id: "", status: "inProgress" }]), page([{ id: owned.id, status: "mystery" }]), page([owned], 12)]) {
    const fake = fixture([value]);
    await assert.rejects(quiesce(fake), /invalid|turn|cursor|response/i);
    assert.equal(fake.calls.some(call => call.method === "turn/interrupt"), false);
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during terminal polling cannot return late quiescence`, async () => {
    const fake = fixture([page([owned])]);
    let finish;
    fake.options.waitBeforePoll = async () => new Promise(resolve => { finish = resolve; });
    const operation = quiesce(fake);
    const rejected = assert.rejects(operation, /stopped/);
    rejected.catch(() => {});
    await setImmediate();
    assert.equal(typeof finish, "function", "active turn must enter terminal polling");
    if (stop === "deadline") fake.expire();
    else fake.fail();
    finish();
    await rejected;
    assert.equal(fake.calls.filter(call => call.method === "thread/turns/list").length, 1);
    assert.equal(fake.calls.filter(call => call.method === "turn/interrupt").length, 1);
  });
}

test("omitted optional nextCursor is terminal for both active and completed state pages", async () => {
  const terminal = fixture([{ data: [{ ...owned, status: "completed" }] }]);
  assert.deepEqual(await quiesce(terminal), { interruptRequestedTurnId: null });
  const active = fixture([{ data: [owned] }, { data: [{ ...owned, status: "interrupted" }] }]);
  assert.deepEqual(await quiesce(active), { interruptRequestedTurnId: owned.id });
  assert.equal(active.calls.filter(call => call.method === "turn/interrupt").length, 1);
});

test("a repeated opaque cursor is malformed and cannot trigger interruption", async () => {
  const fake = fixture([
    page([{ id: "old", status: "completed" }], "repeated"),
    page([owned], "repeated"),
  ]);
  await assert.rejects(quiesce(fake), /cursor|pagination|invalid/i);
  assert.equal(fake.calls.filter(call => call.method === "thread/turns/list").length, 2);
  assert.equal(fake.calls.some(call => call.method === "turn/interrupt"), false);
});

test("natural completion after interrupt request reports only what was requested", async () => {
  const fake = fixture([page([owned]), page([{ ...owned, status: "completed" }])]);
  assert.deepEqual(await quiesce(fake), { interruptRequestedTurnId: owned.id });
  assert.equal(fake.calls.filter(call => call.method === "turn/interrupt").length, 1);
});


function interruptFailure(fake, error) {
  const original = fake.session.client.request;
  fake.session.client.request = async (method, params) => {
    if (method === "turn/interrupt") { fake.calls.push({ method, params }); throw error; }
    return original(method, params);
  };
}

test("cleanup rechecks matching terminal state when the owned turn finishes before interruption", async () => {
  const assertTerminal = async (fake) => {
    assert.deepEqual(await quiesce(fake), { interruptRequestedTurnId: owned.id });
    assert.deepEqual(fake.calls.map(call => call.method), ["thread/turns/list", "turn/interrupt", "thread/turns/list"]);
  };
  for (const status of ["completed", "interrupted", "failed"]) {
    const fake = fixture([page([owned]), page([{ ...owned, status }])]);
    interruptFailure(fake, Object.assign(new Error("no active turn to interrupt"), { code: -32600 }));
    await assertTerminal(fake);
  }
});

test("cleanup does not reinterpret other invalid-request codes or messages as natural completion", async () => {
  for (const [code, message] of [[-32600, "wrong active turn"], [-32601, "no active turn to interrupt"], [-32602, "no active turn to interrupt"]]) {
    const error = Object.assign(new Error(message), { code });
    const fake = fixture([page([owned])]); interruptFailure(fake, error);
    await assert.rejects(quiesce(fake), value => value === error);
    assert.deepEqual(fake.calls.map(call => call.method), ["thread/turns/list", "turn/interrupt"]);
  }
});

test("no-active-turn response still requires valid owned terminal state before cleanup", async () => {
  for (const turns of [[{ id: "foreign", status: "inProgress" }, { ...owned, status: "completed" }], [owned, { id: "foreign", status: "inProgress" }], [], [{ ...owned, status: "unknown" }]]) {
    const fake = fixture([page([owned]), page(turns)]);
    interruptFailure(fake, Object.assign(new Error("no active turn to interrupt"), { code: -32600 }));
    await assert.rejects(quiesce(fake), error => error.code !== -32600 && /owned|active|tracked|Invalid/i.test(error.message));
    assert.deepEqual(fake.calls.map(call => call.method), ["thread/turns/list", "turn/interrupt", "thread/turns/list"]);
    assert.equal(fake.calls.filter(call => call.method === "turn/interrupt").length, 1);
  }
});
