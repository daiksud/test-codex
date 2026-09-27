import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import * as flow from "../.github/scripts/codex-issue.mjs";
const repository = "daiksud/test-codex", root = `https://api.github.com/repos/${repository}`;
const headSha = "b".repeat(40), mainSha = "a".repeat(40), threadId = "retained-thread";
const approval = { approvalTurnId: "ui-turn", approvedPlan: "Exact approved Plan" };
const receipt = { id: 42, url: `https://github.com/${repository}/issues/19#issuecomment-42`, repository, issueNumber: 19, threadId, ...approval };
const report = { status: "complete", pullRequestNumber: 7, localBranch: "main", localMainSha: mainSha, clean: true, todo: [], botReviewComplete: true, reason: "" };
function fixture() {
  const calls = [], rpc = [];
  const payloads = {
    [root + "/issues/19"]: { number: 19, state: "closed" },
    [root + "/pulls/7"]: { number: 7, merged: true, merged_at: "2026-09-27T00:00:05Z", base: { ref: "main", repo: { full_name: repository } }, head: { ref: "codex/issue-19", sha: headSha, repo: { full_name: repository } } },
    [root + "/issues/19/timeline?per_page=100&page=1"]: [{ event: "cross-referenced", source: { issue: { number: 7, repository: { full_name: repository }, pull_request: { url: root + "/pulls/7" } } } }],
    [root + "/git/ref/heads/main"]: { ref: "refs/heads/main", object: { sha: mainSha } },
    [root + "/rules/branches/main"]: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "Codex verification" }] } }],
    [root + `/commits/${headSha}/statuses?per_page=100&page=1`]: [{ context: "Codex verification", state: "success", url: root + `/statuses/${headSha}`, target_url: `https://github.com/${repository}/actions/runs/9001`, creator: { login: "github-actions[bot]" } }],
    [root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`]: { check_runs: [] },
    [root + "/pulls/7/reviews?per_page=100&page=1"]: [{ user: { type: "Bot", login: "chatgpt-codex-connector[bot]" }, body: `### 💡 Codex Review\n\n**Reviewed commit:** \`${headSha.slice(0,10)}\``, state: "COMMENTED", commit_id: headSha, submitted_at: "2026-09-27T00:00:00Z" }],
    [root + "/issues/7/comments?per_page=100&page=1"]: [],
  };
  const connections = { reviewRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
  const client = { failure: new Promise(() => {}), implementationProfile: "codex_issue_workspace_fixture", request: async (method, params) => { rpc.push({ method, params }); return method === "thread/read" ? { thread: { id: threadId, model: "gpt-6-sol", reasoningEffort: "high" } } : { turn: { id: "finding-turn" } }; } };
  const session = { actionsRunUrl: `https://github.com/${repository}/actions/runs/9001`, issue: { repository, number: 19, url: `https://github.com/${repository}/issues/19` }, threadId, workspace: "/runner/workspace", client, deadline: { expired: false, expiration: new Promise(() => {}), error: null }, signal: new AbortController().signal };
  const options = { env: { GH_TOKEN: "fixture-token" }, fetchImpl: async (url, input) => {
    calls.push({ url, input }); let data;
    if (url === "https://api.github.com/graphql") { assert.equal(input.method, "POST"); const body = JSON.parse(input.body); assert.match(body.query, /^query /); const field = body.operationName === "IssueReviewRequests" ? "reviewRequests" : "reviewThreads"; data = { data: { repository: { pullRequest: { number: 7, headRefOid: headSha, [field]: connections[field] } } } }; }
    else { assert.equal(input.method, "GET"); assert.ok(Object.hasOwn(payloads, url), url); data = payloads[url]; }
    return { ok: true, status: 200, headers: new Headers(), json: async () => data };
  } };
  return { session, payloads, connections, options, calls, rpc, handoff: { session, approval, receipt, turnId: "completed-turn" }, turn: { status: "completed", text: JSON.stringify(report), error: null } };
}
const facts = { repository, issueNumber: 19, pullRequestNumber: 7, headSha, mainSha };
async function capture(operation) { try { await operation(); assert.fail("Expected mismatch"); } catch (error) { assert.notEqual(error.code, "ERR_ASSERTION"); return error; } }
async function openIssueFinding(fake) { fake.payloads[root + "/issues/19"].state = "open"; return capture(() => flow.reconcileIssueDelivery(fake.session, report, fake.options)); }

test("valid incomplete Issue/PR/link/main state becomes a safe actionable finding", async () => {
  for (const state of ["issue", "pr", "link", "main"]) {
    const fake = fixture();
    if (state === "issue") fake.payloads[root + "/issues/19"].state = "open";
    if (state === "pr") fake.payloads[root + "/pulls/7"].merged = false;
    if (state === "link") fake.payloads[root + "/issues/19/timeline?per_page=100&page=1"] = [];
    if (state === "main") fake.payloads[root + "/git/ref/heads/main"].object.sha = "c".repeat(40);
    const error = await capture(() => flow.reconcileIssueDelivery(fake.session, report, fake.options)); assert.equal(error.code, "ISSUE_DELIVERY_FINDING");
    assert.equal(fake.calls.every(call => call.input.method === "GET"), true);
  }
});

test("valid pending/failing/missing required CI becomes a finding while bad identity stays terminal", async () => {
  for (const state of ["pending", "failure", "missing", "check"]) {
    const fake = fixture(); const url = root + `/commits/${headSha}/statuses?per_page=100&page=1`;
    if (state === "missing" || state === "check") fake.payloads[url] = [];
    else fake.payloads[url][0].state = state;
    if (state === "check") fake.payloads[root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`].check_runs = [{ name: "Codex verification", head_sha: headSha, status: "completed", conclusion: "failure" }];
    const error = await capture(() => flow.verifyIssueRequiredCi(fake.session, facts, fake.options)); assert.equal(error.code, "ISSUE_DELIVERY_FINDING");
  }
});

test("pending Bot requests, stale/changes-requested reviews and unresolved findings are actionable", async () => {
  for (const state of ["request", "stale", "changes", "thread"]) {
    const fake = fixture(); const bot = { __typename: "Bot", login: "fixture-review" };
    if (state === "request") fake.connections.reviewRequests.nodes = [{ requestedReviewer: bot }];
    else fake.payloads[root + "/pulls/7/reviews?per_page=100&page=1"] = [{ user: { type: "Bot", login: "fixture-review[bot]" }, state: state === "changes" ? "CHANGES_REQUESTED" : "COMMENTED", commit_id: state === "stale" ? "c".repeat(40) : headSha, submitted_at: "2026-09-27T00:00:00Z" }];
    if (state === "thread") fake.connections.reviewThreads.nodes = [{ id: "thread", isResolved: false, comments: { nodes: [{ author: bot }], pageInfo: { hasNextPage: false, endCursor: null } } }];
    const error = await capture(() => flow.verifyIssueBotReviews(fake.session, facts, fake.options)); assert.equal(error.code, "ISSUE_DELIVERY_FINDING");
  }
});

test("malformed identities/refs/SHA, policy drift and authentication errors are not findings", async () => {
  for (const mode of ["number", "pr", "main", "policy", "status", "check", "author", "auth"]) {
    const fake = fixture(); let operation;
    if (mode === "number") { fake.payloads[root + "/issues/19"].number = 20; operation = () => flow.reconcileIssueDelivery(fake.session, report, fake.options); }
    if (mode === "pr") { fake.payloads[root + "/pulls/7"].head.ref = "wrong"; operation = () => flow.reconcileIssueDelivery(fake.session, report, fake.options); }
    if (mode === "main") { fake.payloads[root + "/git/ref/heads/main"].object.sha = "invalid"; operation = () => flow.reconcileIssueDelivery(fake.session, report, fake.options); }
    if (mode === "policy") { fake.payloads[root + "/rules/branches/main"][0].parameters.strict_required_status_checks_policy = true; operation = () => flow.verifyIssueRequiredCi(fake.session, facts, fake.options); }
    if (mode === "status") { fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=1`][0].url = root + `/statuses/${"c".repeat(40)}`; operation = () => flow.verifyIssueRequiredCi(fake.session, facts, fake.options); }
    if (mode === "check") { fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=1`] = []; fake.payloads[root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`].check_runs = [{ name: "Codex verification", head_sha: "c".repeat(40), status: "completed", conclusion: "success" }]; operation = () => flow.verifyIssueRequiredCi(fake.session, facts, fake.options); }
    if (mode === "author") { fake.connections.reviewThreads.nodes = [{ id: "thread", isResolved: false, comments: { nodes: [{ author: null }], pageInfo: { hasNextPage: false, endCursor: null } } }]; operation = () => flow.verifyIssueBotReviews(fake.session, facts, fake.options); }
    if (mode === "auth") { fake.options.fetchImpl = async () => ({ ok: false, status: 403, headers: new Headers(), json: async () => ({ message: "private detail" }) }); operation = () => flow.reconcileIssueDelivery(fake.session, report, fake.options); }
    const error = await capture(operation); assert.notEqual(error.code, "ISSUE_DELIVERY_FINDING"); assert.equal(error.message.includes("private detail"), false);
  }
});

test("observer returns a recognized finding with captured complete report and no success evidence", async () => {
  const fake = fixture(); const finding = await openIssueFinding(fake); let reads = 0;
  const outcome = await flow.observeIssueDelivery(fake.handoff, { readTurn: async () => { reads += 1; return fake.turn; }, auditDelivery: async () => { throw finding; } });
  assert.deepEqual(outcome, { turn: fake.turn, report, finding, remoteEvidence: null }); assert.equal(reads, 1);
});

test("one finding starts an approved same-session inspection/ToDo turn without repost or approval", async () => {
  assert.equal(typeof flow.continueIssueAfterFinding, "function");
  const fake = fixture(); const finding = await openIssueFinding(fake);
  assert.equal(await flow.continueIssueAfterFinding(fake.handoff, { turn: fake.turn, report, finding, remoteEvidence: null }), "finding-turn");
  assert.deepEqual(fake.rpc.map(call => call.method), ["thread/read", "turn/start"]);
  const params = fake.rpc[1].params; assert.equal(params.threadId, threadId); assert.equal(params.permissions, fake.session.client.implementationProfile); assert.equal(params.approvalPolicy, "never");
  assert.deepEqual(params.outputSchema.properties.status.enum, ["pending", "complete", "failed"]);
  const prompt = params.input[0].text; assert.ok(prompt.includes(finding.message)); assert.ok(prompt.includes(approval.approvedPlan)); assert.match(prompt, /ToDo/i);
  assert.match(prompt, /inspect.*(?:local|remote).*state/i); assert.match(prompt, /(?:do not|never).*repost.*Plan/i); assert.match(prompt, /(?:do not|never).*approval/i);
});

test("arbitrary coded errors or incomplete turns cannot authorize a finding continuation", async () => {
  assert.equal(typeof flow.continueIssueAfterFinding, "function");
  const fake = fixture(); const finding = await openIssueFinding(fake);
  const counterfeit = Object.assign(new Error(finding.message), { code: "ISSUE_DELIVERY_FINDING" });
  await assert.rejects(flow.observeIssueDelivery(fake.handoff, { readTurn: async () => fake.turn, auditDelivery: async () => { throw counterfeit; } }), error => error === counterfeit);
  for (const value of [null, counterfeit, new Error("ordinary error")]) await assert.rejects(flow.continueIssueAfterFinding(fake.handoff, { turn: fake.turn, report, finding: value }), /finding/i);
  await assert.rejects(flow.continueIssueAfterFinding(fake.handoff, { turn: { status: "failed" }, finding }), /completed|report/i); assert.equal(fake.rpc.length, 0);
});

test("finding continuation rejects changed authority/profile and expiry before RPC", async () => {
  assert.equal(typeof flow.continueIssueAfterFinding, "function");
  for (const mode of ["receipt", "profile", "expiry"]) {
    const fake = fixture(); const finding = await openIssueFinding(fake);
    if (mode === "receipt") fake.handoff.receipt = { ...receipt, approvedPlan: "unapproved" };
    if (mode === "profile") fake.session.client.implementationProfile = "builtin:danger-full-access";
    if (mode === "expiry") { fake.session.deadline.expired = true; fake.session.deadline.error = new Error("stopped"); }
    await assert.rejects(flow.continueIssueAfterFinding(fake.handoff, { turn: fake.turn, report, finding }), /receipt|publication|profile|stopped/i); assert.equal(fake.rpc.length, 0);
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during finding metadata prevents a late write turn`, async () => {
    assert.equal(typeof flow.continueIssueAfterFinding, "function");
    const fake = fixture(); const finding = await openIssueFinding(fake); let rejectStop, finish;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; }); stopped.catch(() => {});
    if (stop === "deadline") fake.session.deadline.expiration = stopped; else fake.session.client.failure = stopped;
    fake.session.client.request = async (method, params) => { fake.rpc.push({ method, params }); return method === "thread/read" ? new Promise(resolve => { finish = resolve; }) : { turn: { id: "unexpected-late-turn" } }; };
    const operation = flow.continueIssueAfterFinding(fake.handoff, { turn: fake.turn, report, finding }); const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {}); await setImmediate();
    if (stop === "deadline") { fake.session.deadline.expired = true; fake.session.deadline.error = new Error("stopped"); }
    rejectStop(new Error("stopped")); finish({ thread: { id: threadId, model: "gpt-6-sol" } }); await rejected; await setImmediate(); assert.equal(fake.rpc.length, 1);
  });
}

test("edited approved Plan comment remains a terminal error, never a repair finding", async () => {
  const fake = fixture(); fake.payloads[root + "/issues/19/comments?per_page=100&page=1"] = [{ id: receipt.id, html_url: receipt.url, user: { login: "github-actions[bot]" }, body: "edited Plan" }];
  const error = await capture(() => flow.verifyIssueDelivery(fake.session, approval, receipt, report, fake.options));
  assert.notEqual(error.code, "ISSUE_DELIVERY_FINDING"); assert.match(error.message, /Plan comment/);
});

test("missing completed-check conclusion is terminal rather than a finding", async () => {
  const fake = fixture(); fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=1`] = [];
  fake.payloads[root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`].check_runs = [{ name: "Codex verification", head_sha: headSha, status: "completed" }];
  const error = await capture(() => flow.verifyIssueRequiredCi(fake.session, facts, fake.options)); assert.notEqual(error.code, "ISSUE_DELIVERY_FINDING");
});

test("malformed Bot-review SHA is terminal rather than a finding", async () => {
  const fake = fixture(); fake.payloads[root + "/pulls/7/reviews?per_page=100&page=1"] = [{ user: { type: "Bot", login: "fixture-review[bot]" }, state: "COMMENTED", commit_id: "invalid", submitted_at: "2026-09-27T00:00:00Z" }];
  const error = await capture(() => flow.verifyIssueBotReviews(fake.session, facts, fake.options)); assert.notEqual(error.code, "ISSUE_DELIVERY_FINDING");
});

for (const status of ["waiting", "requested", "pending"]) {
  test(`GitHub Actions check status ${status} is a valid incomplete finding`, async () => {
    const fake = fixture(); fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=1`] = [];
    fake.payloads[root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`].check_runs = [{ name: "Codex verification", head_sha: headSha, status, conclusion: null }];
    const error = await capture(() => flow.verifyIssueRequiredCi(fake.session, facts, fake.options)); assert.equal(error.code, "ISSUE_DELIVERY_FINDING");
  });
}

test("unknown check-run status is a terminal API-shape error", async () => {
  const fake = fixture(); fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=1`] = [];
  fake.payloads[root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`].check_runs = [{ name: "Codex verification", head_sha: headSha, status: "mystery", conclusion: null }];
  const error = await capture(() => flow.verifyIssueRequiredCi(fake.session, facts, fake.options)); assert.notEqual(error.code, "ISSUE_DELIVERY_FINDING");
});
