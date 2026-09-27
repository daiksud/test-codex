import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import * as flow from "../.github/scripts/codex-issue.mjs";

const repository = "daiksud/test-codex";
const root = `https://api.github.com/repos/${repository}`;
const headSha = "b".repeat(40);
const facts = { repository, issueNumber: 19, pullRequestNumber: 7, headSha, mainSha: "a".repeat(40) };
const context = "Codex verification";
const status = { context, state: "success", url: root + `/statuses/${headSha}` };
const check = { name: context, head_sha: headSha, status: "completed", conclusion: "success" };
function fixture() {
  const controller = new AbortController();
  const deadline = { expired: false, expiration: new Promise(() => {}) };
  const calls = [];
  const payloads = {
    [root + "/rules/branches/main"]: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context }] } }],
    [root + `/commits/${headSha}/statuses?per_page=100&page=1`]: [status],
    [root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=1`]: { check_runs: [] },
  };
  return { calls, payloads, controller, session: { issue: { repository, number: 19 }, client: { failure: new Promise(() => {}) }, deadline, signal: controller.signal },
    fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.method, "GET"); assert.ok(Object.hasOwn(payloads, url), url); return { ok: true, status: 200, headers: new Headers(), json: async () => payloads[url] }; } };
}
function audit(fake, value = facts, options = {}) {
  assert.equal(typeof flow.verifyIssueRequiredCi, "function");
  return flow.verifyIssueRequiredCi(fake.session, value, { env: { GH_TOKEN: "fixture-token" }, fetchImpl: fake.fetchImpl, ...options });
}
function statuses(fake, values, page = 1) { fake.payloads[root + `/commits/${headSha}/statuses?per_page=100&page=${page}`] = values; }
function checks(fake, values, page = 1) { fake.payloads[root + `/commits/${headSha}/check-runs?filter=latest&per_page=100&page=${page}`] = { check_runs: values }; }

test("requires authenticated check read permission without extra write scope", () => {
  const workflow = readFileSync(new URL("../.github/workflows/codex-issue.yml", import.meta.url), "utf8");
  assert.match(workflow, /^      checks: read$/m);
  assert.doesNotMatch(workflow, /^      checks: write$/m);
});

test("accepts status-only, check-only and both passing sources on the exact head", async () => {
  for (const mode of ["status", "check", "both"]) {
    for (const conclusion of ["success", "skipped", "neutral"]) {
      const fake = fixture();
      if (mode === "check") statuses(fake, []);
      if (mode !== "status") checks(fake, [{ ...check, conclusion }]);
      assert.deepEqual(await audit(fake), { headSha, requiredContext: context });
    }
  }
});

test("validates session-bound facts and deadline before any request", async () => {
  for (const change of [{ repository: "fixture/other" }, { issueNumber: 20 }, { pullRequestNumber: null }, { headSha: "invalid" }]) {
    const fake = fixture();
    await assert.rejects(audit(fake, { ...facts, ...change }), /facts|head|Issue|repository/i);
    assert.equal(fake.calls.length, 0);
  }
  const fake = fixture(); fake.session.deadline.expired = true; fake.session.deadline.error = new Error("deadline expired");
  await assert.rejects(audit(fake), /deadline expired/); assert.equal(fake.calls.length, 0);
});

test("fails on drift of effective required context or app binding", async () => {
  for (const rules of [[], {}, [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [] } }],
    [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "other" }] } }],
    [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context }, { context: "extra" }] } }],
    [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context, integration_id: 12 }] } }]]) {
    const fake = fixture(); fake.payloads[root + "/rules/branches/main"] = rules;
    await assert.rejects(audit(fake), /required|rule|binding/i);
  }
});

test("matches current non-strict policy and rejects additional required workflows", async () => {
  const fake = fixture();
  fake.payloads[root + "/rules/branches/main"].push({ type: "pull_request" });
  await audit(fake);
  for (const change of ["strict", "workflows"]) {
    const other = fixture();
    if (change === "strict") other.payloads[root + "/rules/branches/main"][0].parameters.strict_required_status_checks_policy = true;
    else other.payloads[root + "/rules/branches/main"].push({ type: "workflows", parameters: {} });
    await assert.rejects(audit(other), /required|rule|policy|workflow/i);
  }
});

test("missing, failed, pending, stale or malformed CI evidence never passes", async () => {
  for (const [statusValues, checkValues] of [
    [[], []], [[{ ...status, context: "other" }], []], [[{ ...status, state: "failure" }], [check]],
    [[{ ...status, state: "pending" }], [check]], [[status], [{ ...check, conclusion: "failure" }]],
    [[status], [{ ...check, status: "in_progress" }]], [[], [{ ...check, head_sha: "c".repeat(40) }]],
    [[{ ...status, url: root + `/statuses/${"c".repeat(40)}` }], []], [[], [{ ...check, name: "other" }]],
    [{}, []], [[], {}],
  ]) {
    const fake = fixture(); statuses(fake, statusValues); checks(fake, checkValues);
    await assert.rejects(audit(fake), /CI|status|check|head|evidence/i);
  }
});

test("uses newest status per context and paginates both sources", async () => {
  const fake = fixture();
  statuses(fake, [status, { ...status, state: "failure" }, ...Array.from({ length: 98 }, () => ({ ...status, context: "other" }))]);
  statuses(fake, [{ ...status, state: "failure" }], 2);
  checks(fake, Array.from({ length: 100 }, () => ({ ...check, name: "other" })));
  checks(fake, [check], 2);
  assert.deepEqual(await audit(fake), { headSha, requiredContext: context });
  assert.equal(fake.calls.filter(url => url.endsWith("page=2")).length, 2);
  const other = fixture(); statuses(other, [{ ...status, state: "failure" }, status]);
  await assert.rejects(audit(other), /CI|status/i);
});

test("retries transient CI reads but does not retry authentication failures", async () => {
  for (const code of [503, 403]) {
    const fake = fixture(); let count = 0; const delays = [];
    const operation = audit(fake, facts, { fetchImpl: async (url, options) => {
      count += 1;
      if (count === 1) return { ok: false, status: code, headers: new Headers(), json: async () => ({}) };
      return fake.fetchImpl(url, options);
    }, waitBeforeRetry: async ms => { delays.push(ms); } });
    if (code === 403) { await assert.rejects(operation, /403/); assert.equal(count, 1); }
    else { await operation; assert.deepEqual(delays, [1000]); assert.equal(count, 4); }
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} aborts a pending CI read`, async () => {
    const fake = fixture(); let rejectStop;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; }); stopped.catch(() => {});
    if (stop === "deadline") fake.session.deadline.expiration = stopped;
    else fake.session.client.failure = stopped;
    let signal;
    const operation = audit(fake, facts, { fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {});
    await setImmediate();
    if (stop === "deadline") {
      fake.session.deadline.expired = true; fake.session.deadline.error = new Error("stopped");
      fake.controller.abort(fake.session.deadline.error);
    }
    rejectStop(new Error("stopped"));
    await rejected;
    assert.equal(signal.aborted, true);
  });
}
