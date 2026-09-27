import assert from "node:assert/strict";
import test from "node:test";
import { runIssuePlanCli, runIssuePlanJob } from "../.github/scripts/codex-issue.mjs";

// External protocol responses and model reports are simulated, not runner/UI/Git evidence.
test("the default CLI controller composes Plan, approval, publication, continuation and audits", async () => {
  const fake = fixture();
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  const stdout = [], stderr = [];
  let exitCode, session;
  try {
    globalThis.fetch = fake.fetch;
    process.env.GH_TOKEN = "fixture-token";
    await runIssuePlanCli({
      startJob: async () => {
        session = await runIssuePlanJob({
          eventPath: "/fixture/event.json", workspace: "/fixture/checkout",
          env: { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "daiksud/test-codex", GITHUB_RUN_ID: "9001" },
          nowMs: Date.parse(fake.event.issue.created_at), readEvent: () => fake.event,
          createClient: () => fake.client, deadlineScheduler: fake.scheduler,
        });
        return session;
      },
      writeStdout: text => stdout.push(text), writeStderr: text => stderr.push(text),
      setExitCode: code => { exitCode = code; },
    });
    assert.equal(exitCode, 0, stderr.join(""));
    assert.deepEqual(stderr, []);
    assert.deepEqual(fake.order, ["connected", "Plan", "approval", "approval-ended", "Plan-post", "implementation-1", "implementation-2", "audit", "close"]);
    assert.equal(session.threadId, fake.threadId);
    assert.equal(session.deliveryContext.turnId, "implementation-2");
    assert.equal(session.deliveryContext.receipt.approvedPlan, fake.approvedPlan);
    assert.equal(fake.comments.length, 1);
    assert.equal(fake.comments[0].body, `<!-- codex-approved-plan:${fake.threadId}:approval-turn -->\n## Approved Codex Plan\n\n${fake.approvedPlan}`);
    assert.equal(fake.client.closeCount, 1);
    assert.equal(fake.scheduler.cleared, true);
    assert.equal(fake.apiCalls.filter(call => call.method === "POST" && call.url !== "https://api.github.com/graphql").length, 1);
    assert.deepEqual([...new Set(fake.apiCalls.filter(call => call.method === "GET").map(call => call.url))].sort(), fake.expectedReadUrls.sort());
    assert.deepEqual(fake.apiCalls.filter(call => call.url === "https://api.github.com/graphql").map(call => call.operationName), ["IssueReviewRequests", "IssueReviewThreads"]);
    assert.ok(stdout.join("").includes("Remote delivery conditions checked"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

function fixture() {
  const repository = "daiksud/test-codex", number = 19;
  const root = `https://api.github.com/repos/${repository}`;
  const threadId = "fixture-thread", approvedPlan = "承認時に編集した計画\n1. Check the guide.\n";
  const headSha = "b".repeat(40), mainSha = "a".repeat(40);
  const order = [], events = [], comments = [], apiCalls = [];
  let deliveryTurnCount = 0, planFinished = false, approvalEnded = false, auditStarted = false;
  const report = { status: "complete", pullRequestNumber: 7, localBranch: "main", localMainSha: mainSha, clean: true, todo: [], botReviewComplete: true, reason: "" };
  const event = { action: "opened", issue: { number, title: "Clarify the guide", body: "Check and clarify the guide.", html_url: `https://github.com/${repository}/issues/${number}`, created_at: "2026-09-27T00:00:00Z", user: { login: "daiksud" } }, repository: { full_name: repository } };
  const completed = (turnId, status = "completed") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
  const client = {
    implementationProfile: "codex_issue_workspace_fixture", failure: new Promise(() => {}), closeCount: 0,
    notify(method) { assert.equal(method, "initialized"); },
    async request(method, params = {}) {
      if (method === "initialize") return {};
      if (method === "remoteControl/status/read") { order.push("connected"); return { status: "connected", installationId: "fixture-runner", serverName: "Fixture host" }; }
      if (method === "mcpServerStatus/list") return { data: [] };
      if (method === "collaborationMode/list") return { data: [{ mode: "plan", reasoning_effort: "medium" }] };
      if (method === "model/list") return { data: [{ id: "gpt-6-sol", isDefault: true, hidden: false }] };
      if (method === "thread/start") { assert.equal(params.sandbox, "read-only"); assert.equal(params.historyMode, "legacy"); return { thread: { id: threadId } }; }
      if (method === "thread/read") { assert.equal(params.threadId, threadId); return { thread: { id: threadId, model: "gpt-6-sol", reasoningEffort: "medium" } }; }
      if (method === "turn/interrupt") {
        assert.equal(planFinished, true); assert.equal(params.threadId, threadId); assert.equal(params.turnId, "approval-turn");
        events.push(completed("approval-turn", "interrupted")); return {};
      }
      assert.equal(method, "turn/start"); assert.equal(params.threadId, threadId);
      if (params.collaborationMode.mode === "plan") {
        assert.equal(comments.length, 0); assert.equal(params.sandboxPolicy.type, "readOnly");
        events.push({ method: "item/completed", params: { threadId, turnId: "Plan-turn", item: { type: "plan", text: "Original concrete Plan" } } }, completed("Plan-turn"), { method: "item/started", params: { threadId, turnId: "approval-turn", item: { type: "userMessage", content: [{ type: "text", text: `PLEASE IMPLEMENT THIS PLAN:\n${approvedPlan}` }] } } });
        return { turn: { id: "Plan-turn" } };
      }
      assert.equal(approvalEnded, true); assert.equal(comments.length, 1);
      assert.equal(params.permissions, client.implementationProfile);
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.collaborationMode.mode, "default");
      assert.ok(params.input[0].text.includes(comments[0].html_url));
      assert.match(params.input[0].text, /Git operations yourself.*Git commands/);
      const id = `implementation-${++deliveryTurnCount}`;
      assert.ok(deliveryTurnCount <= 2, "no extra implementation turn"); order.push(id);
      const value = deliveryTurnCount === 1 ? { ...report, status: "pending", localBranch: "codex/issue-19", localMainSha: null, clean: false, botReviewComplete: false, todo: ["Check CI and bot review"], reason: "Continue self-review" } : report;
      events.push({ method: "item/completed", params: { threadId, turnId: id, item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify(value) } } }, completed(id));
      return { turn: { id } };
    },
    async nextEvent() {
      const value = events.shift(); assert.ok(value, "unexpected event read");
      if (value.method === "turn/completed" && value.params.turn.id === "Plan-turn") { planFinished = true; order.push("Plan"); }
      if (value.params.item?.type === "userMessage") { assert.equal(planFinished, true); assert.equal(comments.length, 0); order.push("approval"); }
      if (value.method === "turn/completed" && value.params.turn.id === "approval-turn") { approvalEnded = true; order.push("approval-ended"); }
      return value;
    },
    close() { client.closeCount += 1; order.push("close"); },
  };
  const payloads = {
    [root + "/issues/19"]: { number: 19, state: "closed" },
    [root + "/pulls/7"]: { number: 7, merged: true, merged_at: "2026-09-27T00:00:05Z", base: { ref: "main", repo: { full_name: repository } }, head: { ref: "codex/issue-19", sha: headSha, repo: { full_name: repository } } },
    [root + "/issues/19/timeline?per_page=100&page=1"]: [{ event: "cross-referenced", source: { issue: { number: 7, repository: { full_name: repository }, pull_request: { url: root + "/pulls/7" } } } }],
    [root + "/git/ref/heads/main"]: { ref: "refs/heads/main", object: { sha: mainSha } },
    [root + "/rules/branches/main"]: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "Codex verification" }] } }],
    [root + `/commits/${headSha}/statuses?per_page=100&page=1`]: [{ context: "Codex verification", state: "success", url: root + `/statuses/${headSha}`, target_url: `https://github.com/${repository}/actions/runs/9001`, creator: { login: "github-actions[bot]" } }],
    [root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`]: { check_runs: [] },
    [root + "/pulls/7/reviews?per_page=100&page=1"]: [{ user: { type: "Bot", login: "chatgpt-codex-connector[bot]" }, commit_id: headSha, state: "APPROVED", submitted_at: "2026-09-27T00:00:00Z" }],
  };
  const fetch = async (input, options) => {
    const url = String(input); const call = { url, method: options.method }; apiCalls.push(call);
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    let data;
    if (url === root + "/issues/19/comments" && options.method === "POST") {
      assert.equal(approvalEnded, true); assert.equal(deliveryTurnCount, 0);
      const body = JSON.parse(options.body).body;
      assert.ok(body.endsWith(approvedPlan)); order.push("Plan-post");
      data = { id: 42, body, html_url: event.issue.html_url + "#issuecomment-42", user: { login: "github-actions[bot]" } }; comments.push(data);
    } else if (url === root + "/issues/19/comments?per_page=100&page=1") {
      assert.equal(options.method, "GET"); data = comments;
      if (deliveryTurnCount === 2 && !auditStarted) { auditStarted = true; order.push("audit"); }
    } else {
      assert.equal(deliveryTurnCount, 2, "remote delivery audit follows the final report");
      if (url === "https://api.github.com/graphql") {
        assert.equal(options.method, "POST"); const body = JSON.parse(options.body); assert.match(body.query, /^query /);
        call.operationName = body.operationName;
        const field = body.operationName === "IssueReviewRequests" ? "reviewRequests" : "reviewThreads";
        assert.ok(["IssueReviewRequests", "IssueReviewThreads"].includes(body.operationName));
        const nodes = field === "reviewThreads" ? [{ id: "fixture-thread-review", isResolved: true, comments: { nodes: [{ author: { __typename: "Bot", login: "chatgpt-codex-connector" } }], pageInfo: { hasNextPage: false, endCursor: null } } }] : [];
        data = { data: { repository: { pullRequest: { number: 7, headRefOid: headSha, [field]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      } else { assert.equal(options.method, "GET"); assert.ok(Object.hasOwn(payloads, url), `unexpected network URL ${url}`); data = payloads[url]; }
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => data };
  };
  const scheduler = { cleared: false, setTimeout(callback, ms) { assert.equal(ms, 24 * 60 * 60 * 1000); return callback; }, clearTimeout() { scheduler.cleared = true; } };
  return { order, comments, apiCalls, event, client, fetch, scheduler, threadId, approvedPlan,
    expectedReadUrls: [...Object.keys(payloads), root + "/issues/19/comments?per_page=100&page=1"] };
}
