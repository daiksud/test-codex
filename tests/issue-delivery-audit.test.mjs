import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";
const repository = "daiksud/test-codex", root = `https://api.github.com/repos/${repository}`;
const headSha = "b".repeat(40), mainSha = "a".repeat(40);
const approval = { approvalTurnId: "approval-19", approvedPlan: "Exact approved Plan 日本語\n" };
const receipt = { id: 42, url: `https://github.com/${repository}/issues/19#issuecomment-42`, threadId: "thread-19", approvalTurnId: approval.approvalTurnId, repository, issueNumber: 19, approvedPlan: approval.approvedPlan };
const comment = { id: receipt.id, html_url: receipt.url, user: { login: "github-actions[bot]" }, body: `<!-- codex-approved-plan:${receipt.threadId}:${approval.approvalTurnId} -->\n## Approved Codex Plan\n\n${approval.approvedPlan}` };
const report = { status: "complete", pullRequestNumber: 7, localBranch: "main", localMainSha: mainSha, clean: true, todo: [], botReviewComplete: true, reason: "" };
function fixture() {
  const controller = new AbortController(), calls = [];
  const payloads = {
    [root + "/issues/19/comments?per_page=100&page=1"]: [comment],
    [root + "/issues/19"]: { number: 19, state: "closed" },
    [root + "/pulls/7"]: { number: 7, merged: true, base: { ref: "main", repo: { full_name: repository } }, head: { ref: "codex/issue-19", sha: headSha, repo: { full_name: repository } } },
    [root + "/issues/19/timeline?per_page=100&page=1"]: [{ event: "cross-referenced", source: { issue: { number: 7, repository: { full_name: repository }, pull_request: { url: root + "/pulls/7" } } } }],
    [root + "/git/ref/heads/main"]: { ref: "refs/heads/main", object: { sha: mainSha } },
    [root + "/rules/branches/main"]: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "Codex verification" }] } }],
    [root + `/commits/${headSha}/statuses?per_page=100&page=1`]: [{ context: "Codex verification", state: "success", url: root + `/statuses/${headSha}`, target_url: `https://github.com/${repository}/actions/runs/9001`, creator: { login: "github-actions[bot]" } }],
    [root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`]: { check_runs: [] },
    [root + "/pulls/7/reviews?per_page=100&page=1"]: [{ user: { type: "Bot", login: "chatgpt-codex-connector[bot]" }, state: "COMMENTED", commit_id: headSha, submitted_at: "2026-09-27T00:00:00Z" }],
    [root + "/issues/7/comments?per_page=100&page=1"]: [],
  };
  const graph = field => ({ data: { repository: { pullRequest: { number: 7, headRefOid: headSha, [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  return { controller, calls, payloads, session: { actionsRunUrl: `https://github.com/${repository}/actions/runs/9001`, issue: { repository, number: 19 }, threadId: receipt.threadId, client: { failure: new Promise(() => {}) }, deadline: { expired: false, expiration: new Promise(() => {}) }, signal: controller.signal },
    fetchImpl: async (url, options) => {
      calls.push({ url, options }); let data;
      if (url === "https://api.github.com/graphql") {
        assert.equal(options.method, "POST"); const body = JSON.parse(options.body); assert.match(body.query, /^query /);
        data = graph(body.operationName === "IssueReviewRequests" ? "reviewRequests" : "reviewThreads");
      } else { assert.equal(options.method, "GET"); assert.ok(Object.hasOwn(payloads, url), url); data = payloads[url]; }
      return { ok: true, status: 200, headers: new Headers(), json: async () => data };
    } };
}
function audit(fake, approved = approval, published = receipt, completed = report, options = {}) {
  assert.equal(typeof flow.verifyIssueDelivery, "function");
  return flow.verifyIssueDelivery(fake.session, approved, published, completed, { env: { GH_TOKEN: "fixture-token" }, fetchImpl: fake.fetchImpl, ...options });
}

test("returns only combined remote evidence after approved Plan and every remote audit pass", async () => {
  const fake = fixture();
  assert.deepEqual(await audit(fake), { repository, issueNumber: 19, pullRequestNumber: 7, headSha, mainSha,
    approvedPlanCommentId: 42, ci: { headSha, requiredContext: "Codex verification" }, botReviews: { headSha, bots: ["chatgpt-codex-connector"] } });
  assert.equal(fake.calls.length, 11);
});

test("rejects every receipt/session/approval mismatch and incomplete report before fetching", async () => {
  for (const change of [{ id: 0 }, { url: "https://example.test/wrong" }, { threadId: "other" }, { approvalTurnId: "other" }, { repository: "fixture/other" }, { issueNumber: 20 }, { approvedPlan: "edited" }, { approvedPlan: "" }]) {
    const fake = fixture(); await assert.rejects(audit(fake, approval, { ...receipt, ...change }), /receipt|Plan|approval/i); assert.equal(fake.calls.length, 0);
  }
  const fake = fixture(); await assert.rejects(audit(fake, approval, receipt, { ...report, status: "pending" }), /complete|report/i); assert.equal(fake.calls.length, 0);
  const otherSession = fixture(); otherSession.session.threadId = "other-session";
  await assert.rejects(audit(otherSession), /receipt|session|thread|approval/i); assert.equal(otherSession.calls.length, 0);
  for (const change of [{ clean: false }, { todo: ["Unresolved finding"] }, { botReviewComplete: false }]) {
    const incomplete = fixture(); await assert.rejects(audit(incomplete, approval, receipt, { ...report, ...change }), /complete|report/i); assert.equal(incomplete.calls.length, 0);
  }
  const empty = fixture(); await assert.rejects(audit(empty, { ...approval, approvedPlan: "" }, { ...receipt, approvedPlan: "" }), /Plan|receipt|approval/i); assert.equal(empty.calls.length, 0);
  const expired = fixture(); expired.session.deadline.expired = true; expired.session.deadline.error = new Error("deadline expired");
  await assert.rejects(audit(expired), /deadline expired/); assert.equal(expired.calls.length, 0);
});

test("rejects missing or empty thread and approval-turn IDs even when the receipt matches", async () => {
  for (const value of ["", undefined]) {
    const fake = fixture(); fake.session.threadId = value;
    await assert.rejects(audit(fake, approval, { ...receipt, threadId: value }), /receipt|approval|thread/i); assert.equal(fake.calls.length, 0);
    const other = fixture();
    await assert.rejects(audit(other, { ...approval, approvalTurnId: value }, { ...receipt, approvalTurnId: value }), /receipt|approval|turn/i); assert.equal(other.calls.length, 0);
  }
});

test("requires exact still-published Plan id, URL, body and Bot author; supports page two", async () => {
  for (const change of [{ id: 43 }, { html_url: "https://example.test/other" }, { body: comment.body + "edited" }, { user: { login: "fixture-human" } }]) {
    const fake = fixture(); fake.payloads[root + "/issues/19/comments?per_page=100&page=1"] = [{ ...comment, ...change }];
    await assert.rejects(audit(fake), /Plan|comment/i);
  }
  const fake = fixture(); fake.payloads[root + "/issues/19/comments?per_page=100&page=1"] = Array.from({ length: 100 }, (_, id) => ({ id: id + 1000 }));
  fake.payloads[root + "/issues/19/comments?per_page=100&page=2"] = [comment];
  assert.equal((await audit(fake)).approvedPlanCommentId, 42);
});

test("any structural, required-CI or Bot failure prevents aggregate evidence", async () => {
  for (const mode of ["structure", "ci", "bot", "comments"]) {
    const fake = fixture();
    if (mode === "structure") fake.payloads[root + "/issues/19"].state = "open";
    if (mode === "ci") fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=1`][0].state = "pending";
    if (mode === "bot") fake.payloads[root + "/pulls/7/reviews?per_page=100&page=1"] = [{ user: { type: "Bot", login: "fixture-review[bot]" }, state: "COMMENTED", submitted_at: "2026-09-27T00:00:00Z", commit_id: "c".repeat(40) }];
    if (mode === "comments") fake.payloads[root + "/issues/19/comments?per_page=100&page=1"] = {};
    await assert.rejects(audit(fake), /Issue|CI|Bot|comment/i);
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} aborts aggregate audit`, async () => {
    const fake = fixture(); let rejectStop, signal;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; }); stopped.catch(() => {});
    if (stop === "deadline") fake.session.deadline.expiration = stopped; else fake.session.client.failure = stopped;
    const operation = audit(fake, approval, receipt, report, { fetchImpl: async (url, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
    const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {}); await setImmediate();
    if (stop === "deadline") { fake.session.deadline.expired = true; fake.session.deadline.error = new Error("stopped"); fake.controller.abort(fake.session.deadline.error); }
    rejectStop(new Error("stopped")); await rejected; assert.equal(signal.aborted, true);
  });
}
