import assert from "node:assert/strict";
import test from "node:test";
import {
  remainingIssueBudgetMs,
  startCodexIfWithinDeadline,
} from "../.github/scripts/codex-issue.mjs";

const issueLimitMs = 24 * 60 * 60 * 1000;
const issueCreatedAt = "2026-09-25T00:00:00.000Z";
const issueCreatedAtMs = Date.parse(issueCreatedAt);

test("a newly opened issue receives no more than 24 hours", () => {
  assert.equal(
    remainingIssueBudgetMs(issueCreatedAt, issueCreatedAtMs),
    issueLimitMs,
  );
});

test("a future clock skew cannot extend the issue budget past 24 hours", () => {
  assert.equal(
    remainingIssueBudgetMs(issueCreatedAt, issueCreatedAtMs - 1),
    issueLimitMs,
  );
});

test("time spent queued reduces the remaining issue budget", () => {
  const queueDelayMs = 45 * 60 * 1000;

  assert.equal(
    remainingIssueBudgetMs(issueCreatedAt, issueCreatedAtMs + queueDelayMs),
    issueLimitMs - queueDelayMs,
  );
});

test("one millisecond before the issue deadline still has time remaining", () => {
  assert.equal(
    remainingIssueBudgetMs(
      issueCreatedAt,
      issueCreatedAtMs + issueLimitMs - 1,
    ),
    1,
  );
});

test("the issue budget is exhausted at and after the 24-hour deadline", () => {
  assert.equal(
    remainingIssueBudgetMs(
      issueCreatedAt,
      issueCreatedAtMs + issueLimitMs,
    ),
    0,
  );
  assert.equal(
    remainingIssueBudgetMs(
      issueCreatedAt,
      issueCreatedAtMs + issueLimitMs + 1,
    ),
    0,
  );
});

test("expired preflight does not launch Codex", () => {
  const launches = [];
  const result = startCodexIfWithinDeadline(
    issueCreatedAt,
    issueCreatedAtMs + issueLimitMs,
    (remainingMs) => launches.push(remainingMs),
  );

  assert.deepEqual(result, { status: "expired", remainingMs: 0 });
  assert.deepEqual(launches, []);
});

test("preflight launches once with the final millisecond of budget", () => {
  const launches = [];
  const result = startCodexIfWithinDeadline(
    issueCreatedAt,
    issueCreatedAtMs + issueLimitMs - 1,
    (remainingMs) => {
      launches.push(remainingMs);
      return "started";
    },
  );

  assert.deepEqual(result, {
    status: "started",
    remainingMs: 1,
    launchResult: "started",
  });
  assert.deepEqual(launches, [1]);
});
