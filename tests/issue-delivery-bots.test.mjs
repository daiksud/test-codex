import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as flow from "../.github/scripts/codex-issue.mjs";
const repository = "daiksud/test-codex", headSha = "b".repeat(40);
const facts = { repository, issueNumber: 19, pullRequestNumber: 7, headSha, mainSha: "a".repeat(40) };
const bot = { __typename: "Bot", login: "fixture-review" };
const human = { __typename: "User", login: "fixture-human" };
const review = { user: { type: "Bot", login: "fixture-review[bot]" }, state: "COMMENTED", commit_id: headSha, submitted_at: "2026-09-27T00:00:00Z" };
function connection(nodes = [], endCursor = null) { return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } }; }
function thread(author = bot, isResolved = true) { return { id: "fixture-thread", isResolved, comments: connection([{ author }]) }; }
function fixture() {
  const controller = new AbortController(), calls = [];
  const reviews = [[]], requests = { first: connection() }, threads = { first: connection() }, comments = {};
  const session = { issue: { repository, number: 19 }, signal: controller.signal, client: { failure: new Promise(() => {}) }, deadline: { expired: false, expiration: new Promise(() => {}) } };
  const fake = { controller, calls, reviews, requests, threads, comments, session };
  fake.fetchImpl = async (url, options) => {
    calls.push({ url, options });
    let value;
    if (url.startsWith(`https://api.github.com/repos/${repository}/pulls/7/reviews?`)) {
      assert.equal(options.method, "GET"); value = reviews[Number(new URL(url).searchParams.get("page")) - 1];
    } else {
      assert.equal(url, "https://api.github.com/graphql"); assert.equal(options.method, "POST");
      const body = JSON.parse(options.body); assert.match(body.query, /^query /); assert.doesNotMatch(body.query, /mutation/);
      const page = body.variables.cursor ?? "first";
      if (body.operationName === "IssueReviewComments") value = { data: { node: { id: body.variables.id, comments: comments[page] } } };
      else {
        assert.equal(body.variables.owner, "daiksud"); assert.equal(body.variables.name, "test-codex"); assert.equal(body.variables.number, 7);
        const field = body.operationName === "IssueReviewRequests" ? "reviewRequests" : "reviewThreads";
        value = { data: { repository: { pullRequest: { number: 7, headRefOid: headSha, [field]: (field === "reviewRequests" ? requests : threads)[page] } } } };
      }
    }
    assert.notEqual(value, undefined, url);
    return { ok: true, status: 200, headers: new Headers(), json: async () => value };
  };
  return fake;
}
function audit(fake, value = facts, options = {}) {
  assert.equal(typeof flow.verifyIssueBotReviews, "function");
  return flow.verifyIssueBotReviews(fake.session, value, { env: { GH_TOKEN: "fixture-token" }, fetchImpl: fake.fetchImpl, ...options });
}

test("absent Bot evidence is vacuous and human requests/reviews/threads do not block", async () => {
  const fake = fixture(); fake.requests.first = connection([{ requestedReviewer: human }]); fake.threads.first = connection([thread(human, false)]);
  fake.reviews[0] = [{ ...review, user: { type: "User", login: human.login }, state: "CHANGES_REQUESTED" }];
  assert.deepEqual(await audit(fake), { headSha, bots: [] });
});

test("latest COMMENTED or APPROVED Bot review supersedes historical CHANGES_REQUESTED after resolution", async () => {
  for (const state of ["COMMENTED", "APPROVED"]) {
    const fake = fixture(); fake.reviews[0] = [{ ...review, state: "CHANGES_REQUESTED", commit_id: "c".repeat(40) }, { ...review, state }]; fake.threads.first = connection([thread()]);
    assert.deepEqual(await audit(fake), { headSha, bots: [bot.login] });
  }
});

test("requested, stale, pending, changes-requested, missing or unresolved Bot reviews fail", async () => {
  for (const mode of ["request", "stale", "pending", "changes", "missing", "unresolved", "unsubmitted"]) {
    const fake = fixture(); fake.reviews[0] = [review]; fake.threads.first = connection([thread()]);
    if (mode === "request") fake.requests.first = connection([{ requestedReviewer: bot }]);
    if (mode === "stale") fake.reviews[0] = [{ ...review, commit_id: "c".repeat(40) }];
    if (mode === "pending") fake.reviews[0] = [{ ...review, state: "PENDING" }];
    if (mode === "changes") fake.reviews[0] = [{ ...review, state: "CHANGES_REQUESTED" }];
    if (mode === "missing") fake.reviews[0] = [];
    if (mode === "unresolved") fake.threads.first = connection([thread(bot, false)]);
    if (mode === "unsubmitted") fake.reviews[0] = [{ ...review, submitted_at: null }];
    await assert.rejects(audit(fake), /Bot|bot|review|request|thread/i);
  }
});

test("all Bot participants need their own completed latest-head review", async () => {
  const fake = fixture(); fake.reviews[0] = [review, { ...review, user: { type: "Bot", login: "second-review[bot]" }, commit_id: "c".repeat(40) }];
  await assert.rejects(audit(fake), /review|head/i);
});

test("paginates requests, threads, nested comments and chronological REST reviews", async () => {
  const fake = fixture(); fake.requests.first = connection([{ requestedReviewer: human }], "requests-next"); fake.requests["requests-next"] = connection();
  const first = thread(human); first.comments = connection([{ author: human }], "comments-next");
  fake.threads.first = connection([first], "threads-next"); fake.threads["threads-next"] = connection([thread()]); fake.comments["comments-next"] = connection([{ author: bot }]);
  fake.reviews[0] = Array.from({ length: 100 }, () => ({ ...review, commit_id: "c".repeat(40) })); fake.reviews[1] = [review];
  assert.deepEqual(await audit(fake), { headSha, bots: [bot.login] });
  first.isResolved = false; await assert.rejects(audit(fake), /thread|unresolved/i);
  first.isResolved = true; fake.requests["requests-next"] = connection([{ requestedReviewer: bot }]); await assert.rejects(audit(fake), /request/i);
});

test("session mismatch and expired deadline fail before fetch", async () => {
  for (const changed of [{ repository: "fixture/other" }, { issueNumber: 20 }, { pullRequestNumber: 0 }, { headSha: "bad" }]) {
    const fake = fixture(); await assert.rejects(audit(fake, { ...facts, ...changed }), /facts|Issue|head/i); assert.equal(fake.calls.length, 0);
  }
  const fake = fixture(); fake.session.deadline.expired = true; fake.session.deadline.error = new Error("deadline expired");
  await assert.rejects(audit(fake), /deadline expired/); assert.equal(fake.calls.length, 0);
});

test("malformed, stale-head and query-error responses fail closed", async () => {
  for (const change of ["head", "errors", "connection", "cursor", "reviews", "author"]) {
    const fake = fixture();
    if (change === "reviews") fake.reviews[0] = {};
    if (change === "author") fake.threads.first = connection([thread(null)]);
    if (change === "connection") fake.requests.first = {};
    if (change === "cursor") fake.requests.first = { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } };
    const original = fake.fetchImpl;
    await assert.rejects(audit(fake, facts, { fetchImpl: async (url, options) => {
      const response = await original(url, options);
      if (url.endsWith("graphql") && ["head", "errors"].includes(change)) {
        const data = await response.json();
        if (change === "head") data.data.repository.pullRequest.headRefOid = "c".repeat(40);
        else data.errors = [{ type: "FORBIDDEN", message: "private detail" }];
        return { ...response, json: async () => data };
      }
      return response;
    } }), /Invalid|invalid|head|query|review|Bot|pagination/i);
  }
});

test("retries HTTP200 GraphQL primary rate-limit errors with reset and HTTP503 reads", async () => {
  for (const mode of ["rate", "service"]) {
    const fake = fixture(); const delays = []; let first = true;
    const result = await audit(fake, facts, { now: () => 1000, waitBeforeRetry: async ms => delays.push(ms), fetchImpl: async (url, options) => {
      if (url.endsWith("graphql") && first) {
        first = false;
        return mode === "rate" ? { ok: true, status: 200, headers: new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "8" }), json: async () => ({ errors: [{ type: "RATE_LIMITED", message: "private detail" }] }) } :
          { ok: false, status: 503, headers: new Headers(), json: async () => ({}) };
      }
      return fake.fetchImpl(url, options);
    } });
    assert.deepEqual(result, { headSha, bots: [] }); assert.deepEqual(delays, [mode === "rate" ? 7000 : 1000]);
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} aborts pending bot inspection`, async () => {
    const fake = fixture(); let rejectStop, signal;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; }); stopped.catch(() => {});
    if (stop === "deadline") fake.session.deadline.expiration = stopped; else fake.session.client.failure = stopped;
    const operation = audit(fake, facts, { fetchImpl: async (url, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
    const rejected = assert.rejects(operation, /stopped/); rejected.catch(() => {}); await setImmediate();
    if (stop === "deadline") { fake.session.deadline.expired = true; fake.session.deadline.error = new Error("stopped"); fake.controller.abort(fake.session.deadline.error); }
    rejectStop(new Error("stopped")); await rejected; assert.equal(signal.aborted, true);
  });
}
