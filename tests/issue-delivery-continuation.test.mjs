import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import * as flow from "../.github/scripts/codex-issue.mjs";
const repository = "daiksud/test-codex", threadId = "retained-thread", profile = "codex_issue_workspace_fixture";
const pending = { status: "pending", pullRequestNumber: 7, localBranch: "codex/issue-19", localMainSha: null, clean: false, todo: ["Review latest bot finding", "Re-run CI"], botReviewComplete: false, reason: "CI and review remain pending" };
const approval = { approvalTurnId: "ui-turn", approvedPlan: "Exact edited Plan 日本語" };
const receipt = { id: 42, url: `https://github.com/${repository}/issues/19#issuecomment-42`, repository, issueNumber: 19, threadId, ...approval };
function fixture() {
  const requests = [];
  const client = { implementationProfile: profile, failure: new Promise(() => {}), request: async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/read") return { thread: { id: threadId, model: "gpt-6-sol", reasoningEffort: "high" } };
    if (method === "turn/start") return { turn: { id: "continuation-turn" } };
    throw new Error(`Unexpected ${method}`);
  } };
  const session = { workspace: "/runner/_work/test-codex/test-codex", issue: { repository, number: 19, title: "Update guide", url: `https://github.com/${repository}/issues/19`, body: "Update the guide" }, threadId, client, deadline: { expired: false, expiration: new Promise(() => {}), error: null } };
  return { requests, session, handoff: { session, approval, receipt, turnId: "original-turn" }, outcome: { turn: { status: "completed", text: JSON.stringify(pending), error: null }, report: pending, remoteEvidence: null } };
}
function resume(fake) {
  assert.equal(typeof flow.continuePendingIssueDelivery, "function");
  return flow.continuePendingIssueDelivery(fake.handoff, fake.outcome);
}

test("starts exactly one same-thread continuation with pending context and the scoped profile", async () => {
  const fake = fixture();
  assert.equal(await resume(fake), "continuation-turn");
  assert.deepEqual(fake.requests.map(call => call.method), ["thread/read", "turn/start"]);
  const params = fake.requests[1].params;
  assert.equal(params.threadId, threadId); assert.equal(params.cwd, fake.session.workspace); assert.equal(params.permissions, profile); assert.equal(params.approvalPolicy, "never");
  assert.equal(Object.hasOwn(params, "sandboxPolicy"), false); assert.equal(params.collaborationMode.mode, "default"); assert.equal(params.collaborationMode.settings.model, "gpt-6-sol");
  assert.equal(params.collaborationMode.settings.reasoning_effort, "high"); assert.deepEqual(params.outputSchema.properties.status.enum, ["pending", "complete", "failed"]);
  const prompt = params.input[0].text;
  for (const text of [...pending.todo, pending.reason, approval.approvedPlan, receipt.url]) assert.ok(prompt.includes(text), text);
  assert.match(prompt, /current (?:workspace|branch)|existing branch/i);
  assert.match(prompt, /(?:do not|never) (?:re-create|recreate|create).*branch/i);
  assert.match(prompt, /(?:do not|never) (?:repost|re-post|post).*Plan/i);
  assert.match(prompt, /(?:do not|never) (?:ask|request).*approval/i);
  assert.match(prompt, /Git operations.*yourself/i);
});

test("complete, failed, interrupted or malformed inputs are rejected before RPC", async () => {
  for (const turn of [
    { status: "completed", text: JSON.stringify({ ...pending, status: "failed" }) },
    { status: "completed", text: JSON.stringify({ ...pending, status: "complete", localBranch: "main", localMainSha: "a".repeat(40), clean: true, todo: [], botReviewComplete: true }) },
    { status: "failed", text: JSON.stringify(pending) }, { status: "interrupted", text: JSON.stringify(pending) }, { status: "completed", text: "not JSON" },
  ]) { const fake = fixture(); fake.outcome.turn = turn; await assert.rejects(resume(fake), /pending|completed|JSON|report/i); assert.equal(fake.requests.length, 0); }
});

test("does not accept a changed receipt or a missing/broad profile", async () => {
  for (const change of ["receipt", "profile", "thread"]) {
    const fake = fixture();
    if (change === "receipt") fake.handoff.receipt = { ...receipt, approvedPlan: "unapproved" };
    if (change === "profile") fake.session.client.implementationProfile = "builtin:danger-full-access";
    if (change === "thread") fake.session.threadId = "other-thread";
    await assert.rejects(resume(fake), /receipt|profile|publication/i); assert.equal(fake.requests.length, 0);
  }
});

test("uses the canonical turn report snapshot while reading model metadata", async () => {
  const fake = fixture(); const original = fake.session.client.request;
  fake.session.client.request = async (method, params) => {
    if (method === "thread/read") { fake.outcome.turn.text = "edited after snapshot"; fake.outcome.report = { ...pending, todo: ["UNAPPROVED CHANGE"] }; }
    return original(method, params);
  };
  await resume(fake); const prompt = fake.requests[1].params.input[0].text;
  assert.ok(prompt.includes(pending.todo[0])); assert.equal(prompt.includes("UNAPPROVED CHANGE"), false);
});

test("expiry before or while metadata is read prevents the next write turn", async () => {
  for (const stage of ["before", "during"]) {
    const fake = fixture();
    const expire = () => { fake.session.deadline.expired = true; fake.session.deadline.error = new Error("deadline expired"); };
    if (stage === "before") expire();
    else { const original = fake.session.client.request; fake.session.client.request = async (method, params) => { const result = await original(method, params); expire(); return result; }; }
    await assert.rejects(resume(fake), /deadline expired/); assert.equal(fake.requests.length, stage === "before" ? 0 : 1);
  }
});

test("wrong thread or missing model and ambiguous start outcomes are never replayed", async () => {
  for (const mode of ["thread", "model", "start"]) {
    const fake = fixture(); const original = fake.session.client.request;
    fake.session.client.request = async (method, params) => {
      if (method === "thread/read" && mode !== "start") { fake.requests.push({ method, params }); return { thread: { id: mode === "thread" ? "other" : threadId, model: mode === "model" ? null : "gpt-6-sol" } }; }
      if (method === "turn/start") { fake.requests.push({ method, params }); throw new Error("start outcome unknown"); }
      return original(method, params);
    };
    await assert.rejects(resume(fake), /metadata|thread|outcome/i); assert.equal(fake.requests.filter(call => call.method === "turn/start").length, mode === "start" ? 1 : 0);
  }
});

test("transport loss while metadata is pending never starts a continuation", async () => {
  const fake = fixture(); let rejectFailure, finish;
  fake.session.client.failure = new Promise((resolve, reject) => { rejectFailure = reject; }); fake.session.client.failure.catch(() => {});
  fake.session.client.request = async (method, params) => {
    fake.requests.push({ method, params });
    if (method === "thread/read") return new Promise(resolve => { finish = resolve; });
    return { turn: { id: "unexpected-late-turn" } };
  };
  const operation = resume(fake); const rejected = assert.rejects(operation, /transport lost/); rejected.catch(() => {});
  await setImmediate(); rejectFailure(new Error("transport lost"));
  finish({ thread: { id: threadId, model: "gpt-6-sol" } }); await rejected; await setImmediate(); assert.equal(fake.requests.length, 1);
});

test("missing returned continuation turn ID fails without replay", async () => {
  const fake = fixture(); const original = fake.session.client.request;
  fake.session.client.request = async (method, params) => { const result = await original(method, params); return method === "turn/start" ? { turn: {} } : result; };
  await assert.rejects(resume(fake), /turn ID/i); assert.equal(fake.requests.filter(call => call.method === "turn/start").length, 1);
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during turn-start RPC cannot return or replay a late turn ID`, async () => {
    const fake = fixture(); const original = fake.session.client.request; let finish, rejectStop;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; }); stopped.catch(() => {});
    if (stop === "deadline") fake.session.deadline.expiration = stopped; else fake.session.client.failure = stopped;
    fake.session.client.request = async (method, params) => {
      if (method !== "turn/start") return original(method, params);
      fake.requests.push({ method, params }); return new Promise(resolve => { finish = resolve; });
    };
    const operation = resume(fake); const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {}); await setImmediate();
    if (stop === "deadline") { fake.session.deadline.expired = true; fake.session.deadline.error = new Error("stopped"); }
    rejectStop(new Error("stopped"));
    finish({ turn: { id: "late-turn" } }); await rejected; await setImmediate(); assert.equal(fake.requests.filter(call => call.method === "turn/start").length, 1);
  });
}

test("pending work before a branch or PR exists permits initial creation after state inspection", async () => {
  const fake = fixture(); fake.outcome.turn.text = JSON.stringify({ ...pending, pullRequestNumber: null, localBranch: null, todo: ["Create the initial branch and PR"] });
  await resume(fake); const prompt = fake.requests[1].params.input[0].text;
  assert.match(prompt, /create codex\/issue-19 only if.*absent/i);
  assert.match(prompt, /create (?:the |a )?PR only if.*absent/i);
  assert.match(prompt, /inspect.*(?:local|remote).*state/i);
  assert.match(prompt, /(?:reuse|retain).*existing.*(?:branch|PR)/i);
  assert.match(prompt, /never push directly to main/i);
});
