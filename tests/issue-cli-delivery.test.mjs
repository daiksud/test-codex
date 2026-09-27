import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runIssuePlanCli } from "../.github/scripts/codex-issue.mjs";

function fixture() {
  let rejectExpiration;
  let rejectFailure;
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  expiration.catch(() => {});
  failure.catch(() => {});
  let closeCount = 0;
  let cancelCount = 0;
  let stdout = "";
  let stderr = "";
  let exitCode = null;
  const issue = {
    number: 19,
    repository: "daiksud/test-codex",
    url: "https://github.com/daiksud/test-codex/issues/19",
  };
  const client = {
    failure,
    close() {
      if (!closeCount) closeCount += 1;
    },
  };
  const deadline = {
    expired: false,
    expiration,
    error: null,
    cancel() { cancelCount += 1; },
  };
  const session = { issue, client, deadline, threadId: "retained-thread" };
  const options = {
    startJob: async () => session,
    writeStdout: text => { stdout += text; },
    writeStderr: text => { stderr += text; },
    setExitCode: code => { exitCode = code; },
    commentIssue: async () => {},
  };
  return {
    session,
    options,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get exitCode() { return exitCode; },
    get closeCount() { return closeCount; },
    get cancelCount() { return cancelCount; },
    expire() {
      deadline.expired = true;
      deadline.error = Object.assign(new Error("deadline expired"), {
        code: "ISSUE_DEADLINE_EXCEEDED",
        issue,
      });
      client.close();
      rejectExpiration(deadline.error);
    },
    fail() { rejectFailure(new Error("transport lost")); },
  };
}

const result = {
  report: { status: "complete", localBranch: "main", clean: true },
  remoteEvidence: { pullRequestNumber: 7 },
};

test("CLI executes the retained approved session and closes it only after checked delivery", async () => {
  const fake = fixture();
  let executions = 0;
  let finished = false;
  fake.options.executeDelivery = async session => {
    assert.equal(session, fake.session);
    executions += 1;
    return result;
  };
  const cli = runIssuePlanCli(fake.options).finally(() => { finished = true; });
  try {
    await setImmediate();
    assert.equal(executions, 1);
    assert.equal(finished, true);
    assert.equal(fake.exitCode, 0);
    assert.equal(fake.cancelCount, 1);
    assert.equal(fake.closeCount, 1);
    assert.match(fake.stdout, /Plan generated.*Issue #19/);
    assert.match(fake.stdout, /remote.*conditions.*(?:checked|verified)/i);
    assert.match(fake.stdout, /PR #7/);
    assert.equal(fake.stderr, "");
  } finally {
    if (!finished) fake.expire();
    await cli;
  }
});

test("CLI stays active while approved delivery is pending and closes the owned client on failure", async () => {
  const fake = fixture();
  let executions = 0;
  let rejectDelivery;
  let finished = false;
  fake.options.executeDelivery = async () => {
    executions += 1;
    return new Promise((resolve, reject) => { rejectDelivery = reject; });
  };
  const cli = runIssuePlanCli(fake.options).finally(() => { finished = true; });
  try {
    await setImmediate();
    assert.equal(executions, 1);
    assert.equal(finished, false);
    assert.equal(fake.closeCount, 0);
    assert.equal(fake.cancelCount, 0);
    rejectDelivery(new Error("delivery failed"));
    await cli;
    assert.equal(fake.exitCode, 1);
    assert.match(fake.stderr, /delivery failed/);
    assert.equal(fake.closeCount, 1);
    assert.equal(fake.cancelCount, 1);
    assert.doesNotMatch(fake.stdout, /remote.*conditions.*(?:checked|verified)/i);
  } finally {
    if (!finished) fake.expire();
    await cli;
  }
});

test("CLI cannot emit success without returned remote evidence", async () => {
  const fake = fixture();
  let executions = 0;
  let finished = false;
  fake.options.executeDelivery = async () => {
    executions += 1;
    return { ...result, remoteEvidence: null };
  };
  const cli = runIssuePlanCli(fake.options).finally(() => { finished = true; });
  try {
    await setImmediate();
    assert.equal(executions, 1);
    assert.equal(finished, true);
    assert.equal(fake.exitCode, 1);
    assert.doesNotMatch(fake.stdout, /remote.*conditions.*(?:checked|verified)/i);
    assert.match(fake.stderr, /evidence/i);
    assert.equal(fake.closeCount, 1);
  } finally {
    if (!finished) fake.expire();
    await cli;
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} during delivery cannot print late success or keep the owned server active`, async () => {
    const fake = fixture();
    let executions = 0;
    let finish;
    let finished = false;
    fake.options.executeDelivery = async () => {
      executions += 1;
      return new Promise(resolve => { finish = resolve; });
    };
    const cli = runIssuePlanCli(fake.options).finally(() => { finished = true; });
    try {
      await setImmediate();
      assert.equal(executions, 1);
      if (stop === "deadline") fake.expire();
      else fake.fail();
      finish(result);
      await cli;
      assert.equal(fake.exitCode, 1);
      assert.doesNotMatch(fake.stdout, /remote.*conditions.*(?:checked|verified)/i);
      assert.equal(fake.closeCount, 1);
    } finally {
      if (!finished) fake.expire();
      await cli;
    }
  });
}

test("CLI records failure before approved cleanup and closes the client only afterward", async () => {
  const fake = fixture();
  fake.session.deliveryContext = { approval: {}, receipt: {}, turnId: "owned-turn" };
  const order = [];
  fake.options.executeDelivery = async () => { throw new Error("original failure"); };
  fake.options.cleanupSession = async (session, reason) => {
    assert.equal(session, fake.session);
    assert.equal(reason, "original failure");
    assert.equal(fake.exitCode, 1);
    assert.match(fake.stderr, /original failure/);
    assert.equal(fake.closeCount, 0);
    order.push("cleanup");
    return { status: "failed", cleanupReport: { localBranch: "main", clean: true } };
  };
  await runIssuePlanCli(fake.options);
  assert.deepEqual(order, ["cleanup"]);
  assert.equal(fake.exitCode, 1);
  assert.equal(fake.closeCount, 1);
  assert.equal(fake.cancelCount, 1);
  assert.match(fake.stdout, /cleanup.*(?:reports|reported)/i);
  assert.doesNotMatch(fake.stdout, /remote.*conditions.*checked/i);
});

test("cleanup failure does not replace the original delivery failure or prevent close", async () => {
  const fake = fixture();
  fake.session.deliveryContext = { approval: {}, receipt: {}, turnId: "owned-turn" };
  let attempts = 0;
  fake.options.executeDelivery = async () => { throw new Error("original failure"); };
  fake.options.cleanupSession = async () => {
    attempts += 1;
    throw new Error("cleanup unavailable");
  };
  await runIssuePlanCli(fake.options);
  assert.equal(attempts, 1);
  assert.equal(fake.exitCode, 1);
  assert.match(fake.stderr, /original failure/);
  assert.match(fake.stderr, /cleanup unavailable/);
  assert.equal(fake.closeCount, 1);
});

test("successful delivery, missing approval, expired session or lost transport cannot invoke failure cleanup", async () => {
  for (const mode of ["success", "unapproved", "expired", "transport"]) {
    const fake = fixture();
    if (mode !== "unapproved") fake.session.deliveryContext = { approval: {}, receipt: {}, turnId: "owned-turn" };
    let attempts = 0;
    fake.options.cleanupSession = async () => { attempts += 1; };
    fake.options.executeDelivery = async () => {
      if (mode === "success") return result;
      if (mode === "expired") fake.expire();
      if (mode === "transport") fake.fail();
      throw new Error("original failure");
    };
    await runIssuePlanCli(fake.options);
    assert.equal(attempts, 0);
    assert.equal(fake.closeCount, 1);
  }
});

test("cleanup reaching the hard deadline records timeout while preserving the original failure", async () => {
  const fake = fixture();
  fake.session.deliveryContext = { approval: {}, receipt: {}, turnId: "owned-turn" };
  const comments = [];
  fake.options.executeDelivery = async () => { throw new Error("original failure"); };
  fake.options.cleanupSession = async () => {
    fake.expire();
    throw fake.session.deadline.error;
  };
  fake.options.commentIssue = async (issue, reason) => { comments.push({ issue, reason }); };
  await runIssuePlanCli(fake.options);
  assert.equal(fake.exitCode, 1);
  assert.match(fake.stderr, /original failure/);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue, fake.session.issue);
  assert.equal(comments[0].reason, "deadline expired");
  assert.equal(fake.closeCount, 1);
});
