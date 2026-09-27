import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";

const repository = "daiksud/test-codex";
const threadId = "approved-thread";
const profile = "codex_issue_workspace_fixture";
const approval = { approvalTurnId: "ui-turn", approvedPlan: "Approved Plan" };
const receipt = {
  id: 42,
  url: `https://github.com/${repository}/issues/19#issuecomment-42`,
  repository,
  issueNumber: 19,
  threadId,
  ...approval,
};

function fixture() {
  const calls = [];
  const client = {
    implementationProfile: profile,
    failure: new Promise(() => {}),
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") {
        return { thread: { id: threadId, model: "gpt-6-sol", reasoningEffort: "high" } };
      }
      if (method === "turn/start") return { turn: { id: "cleanup-turn" } };
      throw new Error(`Unexpected ${method}`);
    },
  };
  const session = {
    workspace: "/runner/workspace",
    issue: { repository, number: 19, url: `https://github.com/${repository}/issues/19` },
    threadId,
    client,
    deadline: { expired: false, expiration: new Promise(() => {}), error: null },
  };
  return { calls, session, handoff: { session, approval, receipt, turnId: "previous-turn" } };
}

function start(fake) {
  assert.equal(typeof flow.startIssueCleanup, "function");
  return flow.startIssueCleanup(fake.handoff, "Original delivery failed");
}

test("starts one cleanup-only turn in the approved session and owned profile", async () => {
  const fake = fixture();
  assert.equal(await start(fake), "cleanup-turn");
  assert.deepEqual(fake.calls.map(call => call.method), ["thread/read", "turn/start"]);
  const params = fake.calls[1].params;
  assert.equal(params.threadId, threadId);
  assert.equal(params.cwd, fake.session.workspace);
  assert.equal(params.permissions, profile);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.collaborationMode.mode, "default");
  assert.equal(params.collaborationMode.settings.model, "gpt-6-sol");
  assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);
  assert.deepEqual(params.outputSchema.properties.status.enum, ["pending", "complete", "failed"]);
  const prompt = params.input[0].text;
  for (const value of ["Original delivery failed", "codex/issue-19", receipt.url]) {
    assert.ok(prompt.includes(value));
  }
  assert.match(prompt, /Git operations.*yourself/i);
  assert.match(prompt, /(?:return|switch).*main/i);
  assert.match(prompt, /(?:fetch|sync).*remote/i);
  assert.match(prompt, /(?:switch|return).*main.*(?:then|before).*delete only.*local.*codex\/issue-19/is);
  assert.match(prompt, /delete only.*codex\/issue-19.*if.*exists/i);
  assert.match(prompt, /(?:never|do not) delete main or other local branches/i);
  assert.match(prompt, /Issue-owned.*(?:changes|files)/i);
  assert.match(prompt, /(?:do not|never).*implementation/i);
  assert.match(prompt, /(?:do not|never).*commit.*push.*(?:PR|pull request).*merge/i);
  assert.match(prompt, /(?:do not|never).*delete.*remote.*branch/i);
  assert.match(prompt, /(?:do not|never).*approval/i);
  assert.match(prompt, /(?:report|status).*failed/i);
});

test("missing/unapproved receipt and invalid profile cannot authorize cleanup writes", async () => {
  for (const mode of ["missing", "edited", "profile"]) {
    const fake = fixture();
    if (mode === "missing") fake.handoff.receipt = null;
    if (mode === "edited") fake.handoff.receipt = { ...receipt, approvedPlan: "not approved" };
    if (mode === "profile") fake.session.client.implementationProfile = "builtin:danger-full-access";
    await assert.rejects(start(fake), /receipt|publication|profile/i);
    assert.equal(fake.calls.length, 0);
  }
});

test("expiry before or while metadata is read cannot start a cleanup turn", async () => {
  for (const stage of ["before", "during"]) {
    const fake = fixture();
    const expire = () => {
      fake.session.deadline.expired = true;
      fake.session.deadline.error = new Error("deadline expired");
    };
    if (stage === "before") expire();
    else {
      const original = fake.session.client.request;
      fake.session.client.request = async (method, params) => {
        const value = await original(method, params);
        expire();
        return value;
      };
    }
    await assert.rejects(start(fake), /deadline expired/);
    assert.equal(fake.calls.length, stage === "before" ? 0 : 1);
  }
});

test("rejects nontext or empty failure reasons before any RPC", async () => {
  const fake = fixture();
  for (const reason of ["", "  ", { toString: () => "captured failure reason" }]) {
    await assert.rejects(flow.startIssueCleanup(fake.handoff, reason), /reason/i);
  }
  assert.equal(fake.calls.length, 0);
});

test("ambiguous cleanup startup is called once, never replayed", async () => {
  const fake = fixture();
  const original = fake.session.client.request;
  fake.session.client.request = async (method, params) => {
    if (method === "turn/start") {
      fake.calls.push({ method, params });
      throw new Error("cleanup start outcome unknown");
    }
    return original(method, params);
  };
  await assert.rejects(start(fake), /outcome unknown/);
  assert.equal(fake.calls.filter(call => call.method === "turn/start").length, 1);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during cleanup startup rejects a late RPC result`, async () => {
    const fake = fixture();
    let rejectStop;
    let finish;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; });
    stopped.catch(() => {});
    if (stop === "deadline") fake.session.deadline.expiration = stopped;
    else fake.session.client.failure = stopped;
    const original = fake.session.client.request;
    fake.session.client.request = async (method, params) => {
      if (method !== "turn/start") return original(method, params);
      fake.calls.push({ method, params });
      return new Promise(resolve => { finish = resolve; });
    };
    const operation = start(fake);
    const rejected = assert.rejects(operation, /stopped/);
    rejected.catch(() => {});
    await setImmediate();
    if (stop === "deadline") {
      fake.session.deadline.expired = true;
      fake.session.deadline.error = new Error("stopped");
    }
    rejectStop(new Error("stopped"));
    finish({ turn: { id: "late-cleanup" } });
    await rejected;
    await setImmediate();
    assert.equal(fake.calls.filter(call => call.method === "turn/start").length, 1);
  });
}
