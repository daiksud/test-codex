import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";
const repository = "daiksud/test-codex", threadId = "retained-thread", profile = "codex_issue_workspace_fixture";
const approval = { approvalTurnId: "ui-turn", approvedPlan: "Approved exact Plan 日本語" };
const receipt = { id: 42, url: `https://github.com/${repository}/issues/19#issuecomment-42`, repository, issueNumber: 19, threadId, ...approval };
function fixture(info = "serverOverloaded") {
  const calls = []; let rejectFailure, rejectExpiration;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; }); failure.catch(() => {});
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; }); expiration.catch(() => {});
  const client = { failure, implementationProfile: profile, request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: threadId, model: "gpt-6-sol", reasoningEffort: "high" } };
    if (method === "turn/start") return { turn: { id: "retry-turn" } };
    throw new Error(`Unexpected ${method}`);
  } };
  const session = { workspace: "/runner/_work/test-codex/test-codex", issue: { repository, number: 19, url: `https://github.com/${repository}/issues/19` }, threadId, client, deadline: { expired: false, expiration, error: null } };
  return { session, calls, handoff: { session, approval, receipt, turnId: "failed-turn" }, outcome: { turn: { status: "failed", text: null, error: { codexErrorInfo: info } }, report: null, remoteEvidence: null },
    options: { delayMs: 7000, waitBeforeRetry: async (delay, context) => { assert.equal(delay, 7000); assert.equal(context.client, client); assert.equal(context.deadline, session.deadline); calls.push({ method: "backoff" }); } },
    expire() { session.deadline.expired = true; session.deadline.error = new Error("stopped"); rejectExpiration(session.deadline.error); },
    fail() { rejectFailure(new Error("stopped")); } };
}
function retry(fake) { assert.equal(typeof flow.retryIssueImplementation, "function"); return flow.retryIssueImplementation(fake.handoff, fake.outcome, fake.options); }

test("retries one confirmed failed turn after bounded backoff in the approved thread/profile", async () => {
  const fake = fixture(); assert.equal(await retry(fake), "retry-turn");
  assert.deepEqual(fake.calls.map(call => call.method), ["backoff", "thread/read", "turn/start"]);
  const params = fake.calls[2].params; assert.equal(params.threadId, threadId); assert.equal(params.permissions, profile); assert.equal(params.cwd, fake.session.workspace); assert.equal(params.approvalPolicy, "never");
  assert.equal(Object.hasOwn(params, "sandboxPolicy"), false); assert.equal(params.collaborationMode.mode, "default"); assert.equal(params.collaborationMode.settings.model, "gpt-6-sol");
  assert.deepEqual(params.outputSchema.properties.status.enum, ["pending", "complete", "failed"]);
  const prompt = params.input[0].text;
  for (const text of [approval.approvedPlan, receipt.url]) assert.ok(prompt.includes(text));
  assert.match(prompt, /inspect.*(?:local|remote).*state/i); assert.match(prompt, /unknown outcome|outcome is unknown/i); assert.match(prompt, /(?:do not|never).*replay/i);
  assert.match(prompt, /(?:reuse|retain).*existing.*(?:branch|PR)/i);
  assert.match(prompt, /create codex\/issue-19 only if.*absent/i); assert.match(prompt, /create (?:the |a )?PR only if.*absent/i);
  assert.match(prompt, /never push directly to main/i);
  assert.match(prompt, /(?:do not|never) (?:repost|re-post|post).*Plan/i);
  assert.match(prompt, /Git operations.*yourself/i); assert.match(prompt, /(?:do not|never).*approval/i);
});

test("recognizes only documented transient Codex error variants", async () => {
  for (const info of ["rateLimitExceeded", "serverOverloaded", "internalServerError",
    { httpConnectionFailed: { httpStatusCode: 408 } }, { httpConnectionFailed: { httpStatusCode: 429 } }, { httpConnectionFailed: { httpStatusCode: null } },
    { responseStreamConnectionFailed: { httpStatusCode: null } }, { responseStreamDisconnected: { httpStatusCode: 503 } }, { responseTooManyFailedAttempts: { httpStatusCode: 502 } }]) {
    const fake = fixture(info); assert.equal(await retry(fake), "retry-turn"); assert.equal(fake.calls.filter(call => call.method === "turn/start").length, 1);
  }
});

test("interrupted, completed, permanent or unclassified turns never back off or start", async () => {
  for (const info of [null, "unknown", "contextWindowExceeded", { httpConnectionFailed: { httpStatusCode: 401 } }, { responseStreamDisconnected: { httpStatusCode: 403 } }, { responseTooManyFailedAttempts: { httpStatusCode: null } }, { httpConnectionFailed: { httpStatusCode: "503" } }]) {
    const fake = fixture(info); await assert.rejects(retry(fake), /failed|transient|retry/i); assert.equal(fake.calls.length, 0);
  }
  for (const status of ["completed", "interrupted"]) { const fake = fixture(); fake.outcome.turn.status = status; await assert.rejects(retry(fake), /failed|transient|retry/i); assert.equal(fake.calls.length, 0); }
});

test("invalid retained receipt/profile, invalid delay or expiry rejects before backoff/RPC", async () => {
  for (const mode of ["receipt", "profile", "delay", "expiry"]) {
    const fake = fixture();
    if (mode === "receipt") fake.handoff.receipt = { ...receipt, approvalTurnId: "unapproved" };
    if (mode === "profile") fake.session.client.implementationProfile = "builtin:danger-full-access";
    if (mode === "delay") fake.options.delayMs = -1;
    if (mode === "expiry") fake.expire();
    await assert.rejects(retry(fake), /receipt|publication|profile|delay|stopped/i); assert.equal(fake.calls.length, 0);
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during backoff does not start even if the wait finishes late`, async () => {
    const fake = fixture(); let finish;
    fake.options.waitBeforeRetry = async () => new Promise(resolve => { finish = resolve; });
    const operation = retry(fake); const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {}); await setImmediate();
    if (stop === "deadline") fake.expire(); else fake.fail(); finish(); await rejected; await setImmediate(); assert.equal(fake.calls.length, 0);
  });
}

test("ambiguous retry-turn start RPC is called once and never replayed", async () => {
  const fake = fixture(); const original = fake.session.client.request;
  fake.session.client.request = async (method, params) => { if (method === "turn/start") { fake.calls.push({ method, params }); throw new Error("start outcome unknown"); } return original(method, params); };
  await assert.rejects(retry(fake), /outcome unknown/); assert.equal(fake.calls.filter(call => call.method === "turn/start").length, 1);
});
