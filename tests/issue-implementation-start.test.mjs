import assert from "node:assert/strict";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const workspace = "/runner/_work/test-codex/test-codex";
const threadId = "issue-thread";
const profile = "codex_issue_workspace_fixture";
const issue = {
  repository: "daiksud/test-codex", number: 19, title: "Clarify the guide",
  body: "Update the guide and validate the result.", url: "https://github.com/daiksud/test-codex/issues/19",
  createdAt: "2026-09-27T00:00:00Z",
};
const approval = { approvalTurnId: "ui-turn", approvedPlan: "編集済み Plan\n1. Check the guide.\n" };
const receipt = {
  id: 987, url: issue.url + "#issuecomment-987", threadId, repository: issue.repository,
  issueNumber: issue.number, ...approval,
};

function fixture() {
  const requests = [];
  const deadline = { expiration: new Promise(() => {}), expired: false, error: null };
  const client = {
    implementationProfile: profile, failure: new Promise(() => {}),
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/read") return { thread: { id: threadId, model: "gpt-6-sol", reasoningEffort: "high" } };
      if (method === "turn/start") return { turn: { id: "implementation-turn" } };
      throw new Error(`Unexpected request ${method}`);
    },
  };
  return { requests, session: { workspace, issue, threadId, client, deadline, actionsRunUrl: "https://github.com/daiksud/test-codex/actions/runs/9001" } };
}

function start(session, planReceipt = receipt) {
  assert.equal(typeof issueFlow.startApprovedIssueImplementation, "function");
  return issueFlow.startApprovedIssueImplementation(session, approval, planReceipt);
}

test("rejects missing or mismatched publication receipts before any RPC", async () => {
  for (const value of [null, {}, { ...receipt, threadId: "other-thread" },
    { ...receipt, approvalTurnId: "other-turn" }, { ...receipt, repository: "fixture/other" },
    { ...receipt, issueNumber: 20 }, { ...receipt, approvedPlan: "Other plan" },
    { ...receipt, id: 0 }, { ...receipt, url: "https://example.invalid/" }]) {
    const fake = fixture();
    await assert.rejects(start(fake.session, value), /receipt|publication/i);
    assert.equal(fake.requests.length, 0);
  }
});

test("rejects empty or missing session and approval-turn IDs before any RPC", async () => {
  for (const value of ["", undefined]) {
    const fake = fixture(); fake.session.threadId = value;
    await assert.rejects(issueFlow.startApprovedIssueImplementation(fake.session, approval, { ...receipt, threadId: value }), /receipt|publication/i); assert.equal(fake.requests.length, 0);
    const other = fixture();
    await assert.rejects(issueFlow.startApprovedIssueImplementation(other.session, { ...approval, approvalTurnId: value }, { ...receipt, approvalTurnId: value }), /receipt|publication/i); assert.equal(other.requests.length, 0);
  }
});

test("starts the same thread with its owned workspace profile and current model", async () => {
  const fake = fixture();
  assert.equal(await start(fake.session), "implementation-turn");
  assert.deepEqual(fake.requests.map(request => request.method), ["thread/read", "turn/start"]);
  assert.deepEqual(fake.requests[0].params, { threadId, includeTurns: false });
  const params = fake.requests[1].params;
  assert.equal(params.threadId, threadId);
  assert.equal(params.cwd, workspace);
  assert.equal(params.permissions, profile);
  assert.equal(Object.hasOwn(params, "sandboxPolicy"), false);
  assert.equal(params.approvalPolicy, "never");
  assert.deepEqual(params.collaborationMode, {
    mode: "default", settings: { model: "gpt-6-sol", reasoning_effort: "high", developer_instructions: null },
  });
  assert.deepEqual(params.outputSchema, {
    type: "object", additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["pending", "complete", "failed"] },
      pullRequestNumber: { type: ["integer", "null"] },
      localBranch: { type: ["string", "null"] },
      localMainSha: { type: ["string", "null"] },
      clean: { type: "boolean" }, todo: { type: "array", items: { type: "string" } },
      botReviewComplete: { type: "boolean" }, reason: { type: "string" },
    },
    required: ["status", "pullRequestNumber", "localBranch", "localMainSha", "clean", "todo", "botReviewComplete", "reason"],
  });
  const prompt = params.input[0].text;
  assert.ok(prompt.includes(issue.url) && prompt.includes(issue.body));
  assert.ok(prompt.includes(approval.approvedPlan) && prompt.includes(receipt.url));
  assert.ok(prompt.includes("codex/issue-19") && prompt.includes("GITHUB_TOKEN"));
  assert.ok(prompt.includes(fake.session.actionsRunUrl), "the exact status target run URL must be supplied");
  for (const phrase of ["test", "lint", "build", "self-review", "bot", "ToDo", "merge", "cleanup", "retry", "Codex verification"]) {
    assert.ok(prompt.toLowerCase().includes(phrase.toLowerCase()), `missing delivery instruction ${phrase}`);
  }
  assert.match(prompt, /do not (?:ask for|request) human review/i);
  assert.match(prompt, /chatgpt-codex-connector/);
  assert.match(prompt, /@codex review/);
  assert.ok(prompt.includes("@codex review\n\n<!-- codex-issue-review:FULL_PR_HEAD_SHA -->"));
  assert.match(prompt, /inspect existing comments.*exact head marker.*reuse.*before retrying.*(?:uncertain|unknown).*comment POST/is);
  assert.match(prompt, /(?:Git commands directly|Git operations yourself)/i);
  assert.match(prompt, /(?:never|do not) push directly to main/i);
  assert.match(prompt, /commit.*push.*(?:open|create).*pull request/is);
  assert.match(prompt, /(?:while CI|CI is pending).*self-review/is);
  assert.match(prompt, /bot review.*wait.*(?:address|fix).*valid/is);
  assert.match(prompt, /merge only.*required CI.*(?:successful|green).*bot review.*complete.*ToDo.*empty/is);
  assert.match(prompt, /(?:return|switch) to main.*fetch.*sync.*delete.*local.*branch.*clean/is);
  assert.match(prompt, /do not (?:use|create).*worktree/is);
  for (const excluded of ["Docker", "Colima", "devcontainer", "ephemeral sandbox", "GitHub Projects"]) {
    assert.ok(prompt.includes(excluded), `missing Issue #6 exclusion ${excluded}`);
  }
});

test("does not fall back to a missing or broad permission profile", async () => {
  for (const value of [undefined, "", ":danger-full-access"]) {
    const fake = fixture();
    fake.session.client.implementationProfile = value;
    await assert.rejects(start(fake.session), /profile/i);
    assert.equal(fake.requests.length, 0);
  }
});

test("keeps the recorded Plan snapshot while reading thread metadata", async () => {
  assert.equal(typeof issueFlow.startApprovedIssueImplementation, "function");
  const fake = fixture();
  const mutableApproval = { ...approval };
  const originalRequest = fake.session.client.request;
  fake.session.client.request = async (method, params) => {
    if (method === "thread/read") {
      mutableApproval.approvedPlan = "An unrecorded later plan";
      mutableApproval.approvalTurnId = "later-turn";
    }
    return originalRequest(method, params);
  };
  await issueFlow.startApprovedIssueImplementation(fake.session, mutableApproval, receipt);
  const prompt = fake.requests.find(request => request.method === "turn/start").params.input[0].text;
  assert.ok(prompt.includes(receipt.approvedPlan));
  assert.equal(prompt.includes("An unrecorded later plan"), false);
});

test("rejects a wrong thread or missing model instead of starting implementation", async () => {
  for (const thread of [{ id: "other-thread", model: "gpt-6-sol" }, { id: threadId, model: null }]) {
    const fake = fixture();
    fake.session.client.request = async (method, params) => {
      fake.requests.push({ method, params });
      return { thread };
    };
    await assert.rejects(start(fake.session), /thread|model/i);
    assert.deepEqual(fake.requests.map(request => request.method), ["thread/read"]);
  }
});

test("does not select write permissions after the original deadline", async () => {
  const fake = fixture();
  fake.session.deadline.expired = true;
  fake.session.deadline.error = new Error("Issue deadline expired");
  await assert.rejects(start(fake.session), /deadline expired/);
  assert.equal(fake.requests.length, 0);
});

test("checks the deadline again after reading current thread metadata", async () => {
  const fake = fixture();
  fake.session.client.request = async (method, params) => {
    fake.requests.push({ method, params });
    fake.session.deadline.expired = true;
    fake.session.deadline.error = new Error("Issue deadline expired");
    return { thread: { id: threadId, model: "gpt-6-sol" } };
  };
  await assert.rejects(start(fake.session), /deadline expired/);
  assert.deepEqual(fake.requests.map(request => request.method), ["thread/read"]);
});

test("requires a valid started turn ID", async () => {
  const fake = fixture();
  const originalRequest = fake.session.client.request;
  fake.session.client.request = async (method, params) => method === "turn/start" ? { turn: {} } : originalRequest(method, params);
  await assert.rejects(start(fake.session), /turn ID/i);
});


test("start tells Codex to recognize the observed no-findings comment without waiting for another review form", async () => {
  const assertInstruction = prompt => {
    assert.ok(prompt.includes("Codex Review: Didn't find any major issues. Nice work!"));
    assert.match(prompt, /Reviewed commit.*current.*head/is);
    assert.match(prompt, /no-findings.*github-actions\[bot\].*request/is);
    assert.match(prompt, /review.*(?:before|no later than).*merge/is);
  };
  const fake = fixture();
  await start(fake.session);
  assertInstruction(fake.requests.find(call => call.method === "turn/start").params.input[0].text);
});
