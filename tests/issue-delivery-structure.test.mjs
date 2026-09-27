import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const repository = "daiksud/test-codex";
const root = `https://api.github.com/repos/${repository}`;
const mainSha = "a".repeat(40);
const headSha = "b".repeat(40);
const report = {
  status: "complete", pullRequestNumber: 7, localBranch: "main", localMainSha: mainSha,
  clean: true, todo: [], botReviewComplete: true, reason: "",
};
const linked = { event: "cross-referenced", source: { issue: {
  number: 7, repository: { full_name: repository }, pull_request: { url: root + "/pulls/7" },
} } };

function fixture() {
  const controller = new AbortController();
  let rejectFailure;
  let rejectExpiration;
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  failure.catch(() => {});
  expiration.catch(() => {});
  const deadline = { expiration, expired: false, error: null };
  const payloads = {
    [root + "/issues/19"]: { number: 19, state: "closed" },
    [root + "/pulls/7"]: {
      number: 7, merged: true, merged_at: "2026-09-27T00:00:05Z",
      base: { ref: "main", repo: { full_name: repository } },
      head: { ref: "codex/issue-19", sha: headSha, repo: { full_name: repository } },
    },
    [root + "/issues/19/timeline?per_page=100&page=1"]: [linked],
    [root + "/git/ref/heads/main"]: { ref: "refs/heads/main", object: { sha: mainSha } },
  };
  const calls = [];
  return {
    payloads, calls, controller,
    session: { issue: { repository, number: 19 }, client: { failure }, deadline, signal: controller.signal },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer test-only-token");
      if (!Object.hasOwn(payloads, url)) throw new Error(`Unexpected API endpoint ${url}`);
      return { ok: true, status: 200, headers: new Headers(), json: async () => payloads[url] };
    },
    fail: rejectFailure,
    expire() {
      deadline.expired = true;
      deadline.error = new Error("Issue deadline expired");
      controller.abort(deadline.error);
      rejectExpiration(deadline.error);
    },
  };
}

function reconcile(fake, value = report, options = {}) {
  assert.equal(typeof issueFlow.reconcileIssueDelivery, "function");
  return issueFlow.reconcileIssueDelivery(fake.session, value, {
    env: { GH_TOKEN: "test-only-token" }, fetchImpl: fake.fetchImpl, ...options,
  });
}

test("reconciles closed Issue, linked merged PR and synchronized main without full verification", async () => {
  const fake = fixture();
  assert.deepEqual(await reconcile(fake), { repository, issueNumber: 19, pullRequestNumber: 7, headSha, mainSha, mergedAt: "2026-09-27T00:00:05Z" });
  assert.equal(fake.calls.length, 4);
  assert.equal(fake.calls.some(call => call.options.method !== "GET"), false);
});

test("rejects incomplete self-reports before any request", async () => {
  for (const value of [{ ...report, status: "pending" }, { ...report, clean: false },
    { ...report, pullRequestNumber: null }, { ...report, todo: ["Unresolved finding"] },
    { ...report, botReviewComplete: false }]) {
    const fake = fixture();
    await assert.rejects(reconcile(fake, value), /complete|report/);
    assert.equal(fake.calls.length, 0);
  }
});

test("makes no structural request after the original deadline", async () => {
  const fake = fixture();
  fake.expire();
  await assert.rejects(reconcile(fake), /deadline expired/);
  assert.equal(fake.calls.length, 0);
});

test("rejects every mismatched Issue, PR, branch or main condition", async () => {
  const variants = [
    ["/issues/19", { number: 19, state: "open" }],
    ["/issues/19", { number: 20, state: "closed" }],
    ["/pulls/7", { number: 8 }],
    ["/pulls/7", { merged: false }],
    ["/pulls/7", { base: { ref: "other", repo: { full_name: repository } } }],
    ["/pulls/7", { base: { ref: "main", repo: { full_name: "fixture/other" } } }],
    ["/pulls/7", { head: { ref: "wrong-branch", sha: headSha, repo: { full_name: repository } } }],
    ["/pulls/7", { head: { ref: "codex/issue-19", sha: headSha, repo: { full_name: "fixture/other" } } }],
    ["/pulls/7", { head: { ref: "codex/issue-19", sha: "invalid", repo: { full_name: repository } } }],
    ["/git/ref/heads/main", { object: { sha: "c".repeat(40) } }],
  ];
  for (const [path, change] of variants) {
    const fake = fixture();
    fake.payloads[root + path] = { ...fake.payloads[root + path], ...change };
    await assert.rejects(reconcile(fake), /Issue|PR|main|branch|head/i);
  }
});

test("requires an exact same-repository PR cross-reference, including later pages", async () => {
  const fake = fixture();
  fake.payloads[root + "/issues/19/timeline?per_page=100&page=1"] = Array.from({ length: 100 }, () => ({ event: "commented" }));
  fake.payloads[root + "/issues/19/timeline?per_page=100&page=2"] = [linked];
  assert.equal((await reconcile(fake)).headSha, headSha);
  assert.ok(fake.calls.some(call => call.url.endsWith("page=2")));
  for (const value of [[], [{ ...linked, source: { issue: { ...linked.source.issue, number: 8 } } }],
    [{ ...linked, source: { issue: { ...linked.source.issue, repository: { full_name: "fixture/other" } } } }],
    [{ ...linked, source: { issue: { ...linked.source.issue, pull_request: { url: root + "/pulls/8" } } } }], {}]) {
    const other = fixture();
    other.payloads[root + "/issues/19/timeline?per_page=100&page=1"] = value;
    await assert.rejects(reconcile(other), /link|timeline|reference/i);
  }
});

test("retries only transient reads with existing GitHub rate-limit timing", async () => {
  for (const status of [503, 429]) {
    const fake = fixture();
    let count = 0;
    const delays = [];
    const fetchImpl = async (url, options) => {
      if (++count === 1) return { ok: false, status, headers: new Headers(status === 429 ? { "retry-after": "7" } : {}), json: async () => ({}) };
      return fake.fetchImpl(url, options);
    };
    await reconcile(fake, report, { fetchImpl, waitBeforeRetry: async ms => { delays.push(ms); } });
    assert.deepEqual(delays, [status === 429 ? 7000 : 1000]);
    assert.equal(count, 5);
  }
});

test("fails closed on authentication failure or exhausted read retries", async () => {
  for (const status of [403, 503]) {
    const fake = fixture();
    let count = 0;
    await assert.rejects(reconcile(fake, report, {
      fetchImpl: async () => {
        count += 1;
        return { ok: false, status, headers: new Headers(), json: async () => ({ message: "private detail" }) };
      }, waitBeforeRetry: async () => { assert.ok(count <= 2); },
    }), error => {
      assert.match(error.message, new RegExp(String(status)));
      assert.equal(error.message.includes("private detail"), false);
      return true;
    });
    assert.equal(count, status === 503 ? 3 : 1);
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} cancels structural inspection without claiming success`, async () => {
    const fake = fixture();
    let signal;
    const audit = reconcile(fake, report, {
      fetchImpl: async (url, options) => {
        signal = options.signal;
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    const rejected = assert.rejects(audit, stop === "deadline" ? /deadline expired/ : /transport lost/);
    rejected.catch(() => {});
    await setImmediate();
    assert.ok(signal instanceof AbortSignal);
    if (stop === "deadline") fake.expire();
    else fake.fail(new Error("transport lost"));
    await rejected;
    assert.equal(signal.aborted, true);
  });
}

test("merged structural facts require a valid merge timestamp", async () => {
  for (const value of [undefined, null, "", "not a timestamp", 42]) {
    const fake = fixture(); fake.payloads[root + "/pulls/7"].merged_at = value;
    await assert.rejects(reconcile(fake), /merge.*(?:time|timestamp)|merged_at/i);
  }
});
