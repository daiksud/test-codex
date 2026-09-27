import assert from "node:assert/strict";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const complete = {
  status: "complete", pullRequestNumber: 7, localBranch: "main",
  localMainSha: "a".repeat(40), clean: true, todo: [], botReviewComplete: true, reason: "",
};

function parse(report, status = "completed") {
  assert.equal(typeof issueFlow.parseIssueDeliveryReport, "function");
  return issueFlow.parseIssueDeliveryReport({ status, text: typeof report === "string" ? report : JSON.stringify(report), error: null });
}

test("parses complete self-reported evidence without claiming an API audit", () => {
  assert.deepEqual(parse(complete), complete);
});

test("accepts pending and failed reports as unfinished work", () => {
  for (const status of ["pending", "failed"]) {
    const report = {
      status, pullRequestNumber: null, localBranch: null, localMainSha: null,
      clean: false, todo: ["Review is still pending"], botReviewComplete: false, reason: "Unfinished work",
    };
    assert.deepEqual(parse(report), report);
    assert.notEqual(parse(report).status, "complete");
  }
});

test("rejects malformed JSON or a report that violates the output schema", () => {
  for (const report of ["not JSON", "null", "[]", {}, { ...complete, status: "done" },
    { ...complete, clean: "true" }, { ...complete, todo: [1] },
    { ...complete, reason: null }, { ...complete, unexpected: true }]) {
    assert.throws(() => parse(report), /report|JSON|schema/i);
  }
});

test("rejects every incomplete success condition", () => {
  for (const change of [
    { pullRequestNumber: null }, { pullRequestNumber: 0 }, { pullRequestNumber: -1 },
    { pullRequestNumber: 1.5 }, { localBranch: "codex/issue-19" },
    { localMainSha: "a".repeat(39) }, { localMainSha: "not-a-commit" },
    { clean: false }, { todo: ["Fix a review finding"] }, { botReviewComplete: false },
  ]) {
    assert.throws(() => parse({ ...complete, ...change }), /complete|report|schema/i);
  }
});

test("failed or interrupted App Server turns cannot report delivery success", () => {
  for (const status of ["failed", "interrupted", "inProgress"]) {
    assert.throws(() => parse(complete, status), /turn.*completed|report/i);
  }
});
