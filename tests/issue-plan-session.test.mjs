import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const workspace = "/runner/_work/test-codex/test-codex";
const eventPath = "/runner/_work/_temp/event.json";
const scriptPath = fileURLToPath(
  new URL("../.github/scripts/codex-issue.mjs", import.meta.url),
);
const issueCreatedAt = "2026-09-25T00:00:00.000Z";
const issueEvent = {
  action: "opened",
  issue: {
    number: 19,
    title: "Inspect the parser",
    body: "Check the repository and propose a plan.",
    html_url: "https://github.com/daiksud/test-codex/issues/19",
    created_at: issueCreatedAt,
    user: { login: "daiksud" },
  },
  repository: { full_name: "daiksud/test-codex" },
};
const planText = "1. Inspect the parser.\n2. Specify focused tests.";

class FakeAppServer {
  constructor({ failMethod = null } = {}) {
    this.requests = [];
    this.notifications = [];
    this.closeCount = 0;
    this.events = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-19",
          turnId: "turn-plan",
          item: { type: "plan", text: planText },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-19",
          turn: { id: "turn-plan", status: "completed" },
        },
      },
    ];
    this.failMethod = failMethod;
    this.failure = new Promise((resolve, reject) => {
      this.failTransport = reject;
    });
    this.failure.catch(() => {});
  }

  async request(method, params = {}) {
    this.requests.push({ method, params });
    if (method === this.failMethod) throw new Error(`failed ${method}`);

    switch (method) {
      case "initialize":
        return {};
      case "mcpServerStatus/list":
        return { data: [] };
      case "collaborationMode/list":
        return { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] };
      case "model/list":
        return {
          data: [{ id: "gpt-6-sol", isDefault: true, hidden: false }],
        };
      case "thread/start":
        return { thread: { id: "thread-19" } };
      case "turn/start":
        return { turn: { id: "turn-plan" } };
      default:
        throw new Error(`unexpected request ${method}`);
    }
  }

  notify(method, params = {}) {
    this.notifications.push({ method, params });
  }

  async nextEvent() {
    const event = this.events.shift();
    if (!event) throw new Error("unexpected end of fake event stream");
    return event;
  }

  close() {
    if (this.closeCount > 0) return;
    this.closeCount += 1;
  }
}

class BlockingPlanAppServer extends FakeAppServer {
  constructor() {
    super();
    this.waitForPlanEvent = new Promise((resolve) => {
      this.resolveWaiting = resolve;
    });
  }

  nextEvent() {
    return new Promise((resolve, reject) => {
      this.rejectPendingEvent = reject;
      this.resolveWaiting();
    });
  }

  close() {
    super.close();
    this.rejectPendingEvent?.(new Error("Codex app-server client is closed"));
  }
}

function createFakeDeadlineScheduler() {
  const tasks = [];
  return {
    tasks,
    setTimeout(callback, delayMs) {
      const task = { callback, delayMs, cleared: false };
      tasks.push(task);
      return task;
    },
    clearTimeout(task) {
      task.cleared = true;
    },
    fire(task = tasks[0]) {
      assert.ok(task, "a deadline timer must have been scheduled");
      assert.equal(task.cleared, false);
      task.callback();
    },
  };
}

function requireStartIssuePlanSession() {
  assert.equal(
    typeof issueFlow.startIssuePlanSession,
    "function",
    "the Issue flow must expose its plan-session entrypoint",
  );
  return issueFlow.startIssuePlanSession;
}

function requireRunIssuePlanJob() {
  assert.equal(
    typeof issueFlow.runIssuePlanJob,
    "function",
    "the Issue flow must expose its runnable job entrypoint",
  );
  return issueFlow.runIssuePlanJob;
}

function requireRunIssuePlanCli() {
  assert.equal(
    typeof issueFlow.runIssuePlanCli,
    "function",
    "the CLI must remain active until the retained Issue session expires",
  );
  return issueFlow.runIssuePlanCli;
}

function requirePostIssueFailureComment() {
  assert.equal(
    typeof issueFlow.postIssueFailureComment,
    "function",
    "deadline reporting must use the Issue comments API",
  );
  return issueFlow.postIssueFailureComment;
}

test("starts one Plan session from the GitHub issue event and retains its client", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new FakeAppServer();
  const createdClients = [];
  let receivedEventPath;

  const session = await startIssuePlanSession({
    eventPath,
    workspace,
    nowMs: Date.parse(issueCreatedAt),
    deadlineScheduler,
    readEvent: (path) => {
      receivedEventPath = path;
      return issueEvent;
    },
    createClient: (options) => {
      createdClients.push(options);
      return client;
    },
  });

  assert.equal(receivedEventPath, eventPath);
  assert.deepEqual(createdClients, [{ workspace }]);
  assert.equal(session.status, "started");
  assert.equal(session.remainingMs, 24 * 60 * 60 * 1000);
  assert.equal(session.client, client);
  assert.equal(session.threadId, "thread-19");
  assert.equal(session.turnId, "turn-plan");
  assert.equal(session.plan, planText);
  assert.deepEqual(session.issue, {
    number: 19,
    title: "Inspect the parser",
    body: "Check the repository and propose a plan.",
    url: "https://github.com/daiksud/test-codex/issues/19",
    repository: "daiksud/test-codex",
    createdAt: issueCreatedAt,
  });
  assert.equal(client.closeCount, 0);
  const threadStart = client.requests.find(
    ({ method }) => method === "thread/start",
  );
  assert.equal(threadStart.params.cwd, workspace);
  const planTurn = client.requests.find(({ method }) => method === "turn/start");
  assert.ok(planTurn.params.input[0].text.includes(session.issue.url));
  assert.ok(planTurn.params.input[0].text.includes(session.issue.body));
});

test("defaults the event path and workspace from GitHub Actions environment", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new FakeAppServer();
  let receivedEventPath;
  let receivedWorkspace;

  const session = await startIssuePlanSession({
    env: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_WORKSPACE: workspace,
    },
    nowMs: Date.parse(issueCreatedAt),
    deadlineScheduler,
    readEvent: (path) => {
      receivedEventPath = path;
      return issueEvent;
    },
    createClient: (options) => {
      receivedWorkspace = options.workspace;
      return client;
    },
  });

  assert.equal(receivedEventPath, eventPath);
  assert.equal(receivedWorkspace, workspace);
  assert.equal(session.workspace, workspace);
  assert.equal(session.client, client);
});

test("reads and parses the GitHub event file by default", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const directory = mkdtempSync(join(tmpdir(), "issue-plan-event-"));
  const path = join(directory, "event.json");
  const client = new FakeAppServer();

  try {
    writeFileSync(path, JSON.stringify(issueEvent));
    const session = await startIssuePlanSession({
      env: {
        GITHUB_EVENT_PATH: path,
        GITHUB_WORKSPACE: workspace,
      },
      nowMs: Date.parse(issueCreatedAt),
      deadlineScheduler,
      createClient: () => client,
    });

    assert.equal(session.issue.url, issueEvent.issue.html_url);
    assert.equal(session.issue.repository, issueEvent.repository.full_name);
    assert.equal(session.client, client);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired Issue does not create an app-server client", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  let createdClients = 0;

  const result = await startIssuePlanSession({
    eventPath,
    workspace,
    nowMs: Date.parse(issueCreatedAt) + 24 * 60 * 60 * 1000,
    deadlineScheduler,
    readEvent: () => issueEvent,
    createClient: () => {
      createdClients += 1;
      return new FakeAppServer();
    },
  });

  assert.deepEqual(result, {
    status: "expired",
    remainingMs: 0,
    issue: {
      number: 19,
      title: "Inspect the parser",
      body: "Check the repository and propose a plan.",
      url: "https://github.com/daiksud/test-codex/issues/19",
      repository: "daiksud/test-codex",
      createdAt: issueCreatedAt,
    },
  });
  assert.equal(createdClients, 0);
  assert.equal(deadlineScheduler.tasks.length, 0);
});

test("Issue deadline expires during Plan, closes the client once, and rejects startup", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new BlockingPlanAppServer();
  const startup = startIssuePlanSession({
    eventPath,
    workspace,
    nowMs: Date.parse(issueCreatedAt),
    deadlineScheduler,
    readEvent: () => issueEvent,
    createClient: () => {
      assert.equal(
        deadlineScheduler.tasks.length,
        1,
        "the absolute deadline must be armed before the client starts",
      );
      return client;
    },
  });

  await client.waitForPlanEvent;
  assert.equal(deadlineScheduler.tasks.length, 1);
  assert.equal(deadlineScheduler.tasks[0].delayMs, 24 * 60 * 60 * 1000);

  deadlineScheduler.fire();
  await assert.rejects(startup, /Issue deadline expired/);
  assert.equal(client.closeCount, 1);
  assert.equal(deadlineScheduler.tasks[0].cleared, false);
});

test("the same Issue deadline stays armed after Plan and expires the retained session", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new FakeAppServer();
  const session = await startIssuePlanSession({
    eventPath,
    workspace,
    nowMs: Date.parse(issueCreatedAt),
    deadlineScheduler,
    readEvent: () => issueEvent,
    createClient: () => client,
  });

  assert.equal(deadlineScheduler.tasks.length, 1);
  assert.equal(deadlineScheduler.tasks[0].cleared, false);
  assert.equal(session.deadline.expired, false);
  const expiry = assert.rejects(session.deadline.expiration, /Issue deadline expired/);

  deadlineScheduler.fire();

  await expiry;
  assert.equal(session.deadline.expired, true);
  assert.equal(client.closeCount, 1);
  assert.equal(deadlineScheduler.tasks[0].cleared, false);
});

test("CLI stays active after Plan and fails when the retained Issue deadline expires", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const runIssuePlanCli = requireRunIssuePlanCli();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new FakeAppServer();
  const session = await startIssuePlanSession({
    eventPath,
    workspace,
    nowMs: Date.parse(issueCreatedAt),
    deadlineScheduler,
    readEvent: () => issueEvent,
    createClient: () => client,
  });
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  let cliFinished = false;
  const reportedFailures = [];
  let failureSetBeforeComment = false;
  let diagnosticWrittenBeforeComment = false;

  const cli = runIssuePlanCli({
    startJob: async () => session,
    commentIssue: async (issue, reason) => {
      failureSetBeforeComment = exitCode === 1;
      diagnosticWrittenBeforeComment = stderr.includes(reason);
      reportedFailures.push({ issue, reason });
    },
    writeStdout: (text) => (stdout += text),
    writeStderr: (text) => (stderr += text),
    setExitCode: (code) => (exitCode = code),
  }).finally(() => {
    cliFinished = true;
  });

  await Promise.resolve();
  assert.equal(cliFinished, false, "the CLI must wait after Plan generation");
  assert.match(stdout, /Codex Plan generated for Issue #19/);

  deadlineScheduler.fire();
  await cli;

  assert.equal(cliFinished, true);
  assert.equal(client.closeCount, 1);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Issue deadline expired/);
  assert.equal(failureSetBeforeComment, true, "failure must be set before best-effort reporting");
  assert.equal(diagnosticWrittenBeforeComment, true, "primary failure must be logged before reporting");
  assert.deepEqual(reportedFailures, [
    {
      issue: session.issue,
      reason: "Issue deadline expired after 24 hours",
    },
  ]);
});

test("CLI reports a pre-expired Issue without starting Codex", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const runIssuePlanJob = requireRunIssuePlanJob();
  const runIssuePlanCli = requireRunIssuePlanCli();
  const deadlineScheduler = createFakeDeadlineScheduler();
  let createdClients = 0;
  let exitCode = 0;
  let stderr = "";
  const reportedFailures = [];

  const cli = runIssuePlanCli({
    startJob: () =>
      runIssuePlanJob({
        startSession: () =>
          startIssuePlanSession({
            eventPath,
            workspace,
            nowMs: Date.parse(issueCreatedAt) + 24 * 60 * 60 * 1000,
            deadlineScheduler,
            readEvent: () => issueEvent,
            createClient: () => {
              createdClients += 1;
              return new FakeAppServer();
            },
          }),
      }),
    commentIssue: async (issue, reason) => {
      reportedFailures.push({ issue, reason });
    },
    writeStderr: (text) => (stderr += text),
    setExitCode: (code) => (exitCode = code),
  });

  await cli;

  assert.equal(createdClients, 0);
  assert.equal(deadlineScheduler.tasks.length, 0);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Issue deadline expired before Codex Plan startup/);
  assert.deepEqual(reportedFailures, [
    {
      issue: {
        number: 19,
        title: "Inspect the parser",
        body: "Check the repository and propose a plan.",
        url: "https://github.com/daiksud/test-codex/issues/19",
        repository: "daiksud/test-codex",
        createdAt: issueCreatedAt,
      },
      reason: "Issue deadline expired before Codex Plan startup",
    },
  ]);
});

test("CLI fails promptly on an idle transport loss and cancels its deadline", async () => {
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new FakeAppServer();
  const session = await issueFlow.startIssuePlanSession({
    eventPath, workspace, nowMs: Date.parse(issueCreatedAt), deadlineScheduler,
    readEvent: () => issueEvent, createClient: () => client,
  });
  let exitCode = 0;
  let stderr = "";
  let commentCalls = 0;
  const cli = issueFlow.runIssuePlanCli({
    startJob: async () => session,
    writeStdout: () => {},
    writeStderr: (text) => { stderr += text; },
    setExitCode: (code) => { exitCode = code; },
    commentIssue: async () => { commentCalls += 1; },
  });
  try {
    client.failTransport(new Error("Codex app-server exited (1)"));
    await setImmediate();
    assert.equal(exitCode, 1);
    assert.match(stderr, /Codex app-server exited \(1\)/);
    assert.equal(deadlineScheduler.tasks[0].cleared, true);
    assert.equal(client.closeCount, 1);
    assert.equal(commentCalls, 0);
  } finally {
    if (!deadlineScheduler.tasks[0].cleared) deadlineScheduler.fire();
    await cli;
  }
});

test("CLI preserves non-deadline startup failures without commenting on the Issue", async () => {
  const runIssuePlanCli = requireRunIssuePlanCli();
  let reportAttempts = 0;
  let exitCode = 0;
  let stderr = "";

  await runIssuePlanCli({
    startJob: async () => {
      throw new Error("Codex Plan startup failed");
    },
    commentIssue: async () => {
      reportAttempts += 1;
    },
    writeStderr: (text) => (stderr += text),
    setExitCode: (code) => (exitCode = code),
  });

  assert.equal(reportAttempts, 0);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Codex Plan startup failed/);
});

test("CLI keeps the deadline error when the Issue failure comment fails", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const runIssuePlanJob = requireRunIssuePlanJob();
  const runIssuePlanCli = requireRunIssuePlanCli();
  const deadlineScheduler = createFakeDeadlineScheduler();
  let exitCode = 0;
  let stderr = "";
  const cli = runIssuePlanCli({
    startJob: () =>
      runIssuePlanJob({
        startSession: () =>
          startIssuePlanSession({
            eventPath,
            workspace,
            nowMs: Date.parse(issueCreatedAt),
            deadlineScheduler,
            readEvent: () => issueEvent,
            createClient: () => new FakeAppServer(),
          }),
      }),
    commentIssue: async () => {
      throw new Error("GitHub comment API unavailable");
    },
    writeStderr: (text) => (stderr += text),
    setExitCode: (code) => (exitCode = code),
  });

  await Promise.resolve();
  deadlineScheduler.fire();
  await cli;

  assert.equal(exitCode, 1);
  assert.match(stderr, /Issue deadline expired after 24 hours/);
  assert.match(stderr, /GitHub comment API unavailable/);
});

test("deadline comments use the Issue REST endpoint and scoped GitHub token", async () => {
  const postIssueFailureComment = requirePostIssueFailureComment();
  const requests = [];
  const originalTimeout = AbortSignal.timeout;
  const timeoutController = new AbortController();
  let timeoutMs;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return timeoutController.signal;
  };
  try {
    await postIssueFailureComment(
      {
        repository: "daiksud/test-codex",
        number: 19,
      },
      "Issue deadline expired after 24 hours",
      {
        env: { GH_TOKEN: "test-token" },
        fetchImpl: async (url, options) => {
          requests.push({ url: String(url), options });
          return { ok: true, status: 201 };
        },
      },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.equal(timeoutMs, 5000, "best-effort reporting needs a bounded timeout");
  assert.equal(requests[0].options.signal, timeoutController.signal);

  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/daiksud/test-codex/issues/19/comments",
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(
    requests[0].options.headers.Accept,
    "application/vnd.github+json",
  );
  assert.equal(
    requests[0].options.headers["X-GitHub-Api-Version"],
    "2026-03-10",
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    body: "Codex automation failed: Issue deadline expired after 24 hours.",
  });
});

test("deadline reporting propagates cancellation to a pending API request", async () => {
  const controller = new AbortController();
  const timeoutError = new Error("failure-report timeout");
  const report = issueFlow.postIssueFailureComment(
    { repository: "daiksud/test-codex", number: 19 },
    "Issue deadline expired after 24 hours",
    {
      env: { GH_TOKEN: "test-token" },
      signal: controller.signal,
      fetchImpl: async (url, options) => {
        assert.equal(options.signal, controller.signal, "report cancellation must reach fetch");
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    },
  );
  const failure = assert.rejects(report, (error) => error === timeoutError);
  controller.abort(timeoutError);
  await failure;
});

test("deadline comment does not make a request without a GitHub token", async () => {
  const postIssueFailureComment = requirePostIssueFailureComment();
  let fetchCalls = 0;

  await assert.rejects(
    postIssueFailureComment(
      { repository: "daiksud/test-codex", number: 19 },
      "Issue deadline expired after 24 hours",
      {
        env: { GH_TOKEN: "" },
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: true, status: 201 };
        },
      },
    ),
    /GH_TOKEN is required/,
  );
  assert.equal(fetchCalls, 0);
});

test("deadline comment reports non-success responses without echoing credentials", async () => {
  const postIssueFailureComment = requirePostIssueFailureComment();

  await assert.rejects(
    postIssueFailureComment(
      { repository: "daiksud/test-codex", number: 19 },
      "Issue deadline expired after 24 hours",
      {
        env: { GH_TOKEN: "test-token" },
        fetchImpl: async () => ({ ok: false, status: 403 }),
      },
    ),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /test-token/);
      return true;
    },
  );
});

test("checks the issue deadline after reading the event payload", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const issueLimitMs = 24 * 60 * 60 * 1000;
  const nowBeforeRead = Date.parse(issueCreatedAt) + issueLimitMs - 1;
  let currentTime = nowBeforeRead;
  const originalNow = Date.now;
  let createdClients = 0;
  Date.now = () => currentTime;

  try {
    const result = await startIssuePlanSession({
      eventPath,
      workspace,
      readEvent: () => {
        currentTime = Date.parse(issueCreatedAt) + issueLimitMs;
        return issueEvent;
      },
      createClient: () => {
        createdClients += 1;
        return new FakeAppServer();
      },
    });

    assert.equal(createdClients, 0);
    assert.equal(result.status, "expired");
    assert.equal(result.remainingMs, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("closes the owned app-server when Plan startup fails", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  const deadlineScheduler = createFakeDeadlineScheduler();
  const client = new FakeAppServer({ failMethod: "mcpServerStatus/list" });

  await assert.rejects(
    startIssuePlanSession({
      eventPath,
      workspace,
      nowMs: Date.parse(issueCreatedAt),
      deadlineScheduler,
      readEvent: () => issueEvent,
      createClient: () => client,
    }),
    /failed mcpServerStatus\/list/,
  );
  assert.equal(client.closeCount, 1);
  assert.equal(
    deadlineScheduler.tasks[0]?.cleared,
    true,
    "a terminal startup failure must cancel its scheduled deadline",
  );
});

test("invalid event or workspace fails before app-server startup", async () => {
  const startIssuePlanSession = requireStartIssuePlanSession();
  let createdClients = 0;
  const options = {
    eventPath,
    workspace,
    nowMs: Date.parse(issueCreatedAt),
    readEvent: () => issueEvent,
    createClient: () => {
      createdClients += 1;
      return new FakeAppServer();
    },
  };

  await assert.rejects(
    startIssuePlanSession({ ...options, eventPath: "" }),
    /event path is required/,
  );
  await assert.rejects(
    startIssuePlanSession({ ...options, workspace: "" }),
    /workspace is required/,
  );
  await assert.rejects(
    startIssuePlanSession({ ...options, readEvent: () => { throw new SyntaxError("invalid JSON"); } }),
    /invalid JSON/,
  );
  assert.equal(createdClients, 0);
});

test("runnable job keeps the successful Plan session alive", async () => {
  const runIssuePlanJob = requireRunIssuePlanJob();
  let closeCount = 0;
  const session = {
    status: "started",
    threadId: "thread-19",
    client: { close: () => (closeCount += 1) },
  };

  const result = await runIssuePlanJob({
    startSession: async () => session,
  });

  assert.equal(result, session);
  assert.equal(closeCount, 0);
});

test("runnable job fails when the deadline expires or startup fails", async () => {
  const runIssuePlanJob = requireRunIssuePlanJob();

  await assert.rejects(
    runIssuePlanJob({
      startSession: async () => ({ status: "expired", remainingMs: 0 }),
    }),
    /Issue deadline expired before Codex Plan startup/,
  );

  const startupError = new Error("app-server startup failed");
  await assert.rejects(
    runIssuePlanJob({
      startSession: async () => {
        throw startupError;
      },
    }),
    (error) => error === startupError,
  );
});

test("direct CLI execution exits nonzero for an expired event without Codex", () => {
  const directory = mkdtempSync(join(tmpdir(), "issue-plan-expired-cli-"));
  const path = join(directory, "event.json");
  const expiredEvent = structuredClone(issueEvent);
  expiredEvent.issue.created_at = "2020-01-01T00:00:00.000Z";

  try {
    writeFileSync(path, JSON.stringify(expiredEvent));
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_EVENT_PATH: path,
        GITHUB_WORKSPACE: workspace,
        PATH: directory,
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Issue deadline expired before Codex Plan startup/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const stop of ["deadline", "transport"]) {
  test(`${stop} cancels Plan retry backoff without starting another turn`, async () => {
    const scheduler = createFakeDeadlineScheduler();
    const client = new FakeAppServer();
    client.events = [{ method: "turn/completed", params: {
      threadId: "thread-19",
      turn: { id: "turn-plan", status: "failed", error: {
        message: "temporarily overloaded", codexErrorInfo: "serverOverloaded",
      } },
    } }];
    const stopError = new Error("app-server connection lost during retry");
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let backoff;
    let backoffCleared = false;
    let deadlineFired = false;
    globalThis.setTimeout = (callback, delayMs) => {
      backoff = { callback, delayMs };
      return backoff;
    };
    globalThis.clearTimeout = (timer) => {
      if (timer === backoff) backoffCleared = true;
    };
    const startup = issueFlow.startIssuePlanSession({
      eventPath, workspace, nowMs: Date.parse(issueCreatedAt), deadlineScheduler: scheduler,
      readEvent: () => issueEvent, createClient: () => client,
    });
    let settled = false;
    startup.then(() => { settled = true; }, () => { settled = true; });
    try {
      await setImmediate();
      assert.ok(backoff, "a transient failure must enter backoff before another Plan turn");
      assert.equal(backoff.delayMs, 1000);
      if (stop === "deadline") {
        deadlineFired = true;
        scheduler.fire();
      } else {
        client.failTransport(stopError);
      }
      await setImmediate();
      assert.equal(settled, true, "terminal loss must interrupt retry waiting promptly");
      await assert.rejects(startup, (error) => stop === "deadline"
        ? /Issue deadline expired/.test(error.message) : error === stopError);
      assert.equal(backoffCleared, true);
      assert.equal(client.requests.filter((r) => r.method === "turn/start").length, 1);
      assert.equal(client.closeCount, 1);
    } finally {
      if (!deadlineFired && !scheduler.tasks[0].cleared) scheduler.fire();
      client.failTransport(stopError);
      if (backoff && !backoffCleared) backoff.callback();
      await startup.catch(() => {});
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
}
