import assert from "node:assert/strict";
import test from "node:test";
import { startIssuePlanTurn } from "../.github/scripts/codex-issue.mjs";

const workspace = "/runner/_work/test-codex/test-codex";
const issue = {
  number: 6,
  title: "PoC: Issue to Codex",
  body: "Inspect the repository, create a plan, and wait for approval.",
  url: "https://github.com/daiksud/test-codex/issues/6",
  repository: "daiksud/test-codex",
};
const planText = "1. Inspect the workflow.\n2. Verify its tests.";

class FakeAppServer {
  constructor({
    mcpServers = [],
    mcpPages = null,
    modes = null,
    modelPages = null,
    events = null,
    turnIds = ["turn-plan"],
    turnStartError = null,
    remoteStatus = { status: "connected", installationId: "runner", serverName: "Mac mini", environmentId: null },
  } = {}) {
    this.requests = [];
    this.notifications = [];
    this.turnIds = [...turnIds];
    this.turnStartError = turnStartError;
    this.remoteStatus = remoteStatus;
    this.failure = new Promise(() => {});
    this.events =
      events ?? [
        {
          method: "item/completed",
          params: {
            threadId: "thread-issue-6",
            turnId: "turn-plan",
            item: { id: "item-plan", type: "plan", text: planText },
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "thread-issue-6",
            turn: { id: "turn-plan", status: "completed" },
          },
        },
      ];
    this.mcpPages = mcpPages ?? [{ data: mcpServers, nextCursor: null }];
    this.modelPages =
      modelPages ?? [
        {
          data: [
            { id: "gpt-6-luna", isDefault: false, hidden: false },
            { id: "gpt-6-sol", isDefault: true, hidden: false },
          ],
          nextCursor: null,
        },
      ];
    this.modes =
      modes ?? [
        { name: "Plan", mode: "plan", reasoning_effort: "medium" },
        { name: "Default", mode: "default" },
      ];
  }

  async request(method, params = {}) {
    this.requests.push({ method, params });

    switch (method) {
      case "initialize":
        return {};
      case "remoteControl/status/read":
        return this.remoteStatus;
      case "mcpServerStatus/list":
        return this.mcpPages.shift();
      case "collaborationMode/list":
        return { data: this.modes };
      case "model/list":
        return this.modelPages.shift();
      case "thread/start":
        return { thread: { id: "thread-issue-6" } };
      case "turn/start":
        if (this.turnStartError) throw this.turnStartError;
        return { turn: { id: this.turnIds.shift(), status: "inProgress" } };
      default:
        throw new Error(`unexpected app-server request: ${method}`);
    }
  }

  notify(method, params = {}) {
    this.notifications.push({ method, params });
  }

  async nextEvent() {
    const event = this.events.shift();
    if (!event) throw new Error("unexpected end of app-server events");
    return event;
  }
}

test("starts one persistent Plan turn with read-only, no-network policy", async () => {
  const appServer = new FakeAppServer();
  const result = await startIssuePlanTurn(appServer, { workspace, issue });

  assert.deepEqual(result, {
    threadId: "thread-issue-6",
    turnId: "turn-plan",
    plan: planText,
  });
  assert.deepEqual(appServer.notifications, [
    { method: "initialized", params: {} },
  ]);
  assert.deepEqual(
    appServer.requests.map(({ method }) => method),
    [
      "initialize",
      "remoteControl/status/read",
      "mcpServerStatus/list",
      "collaborationMode/list",
      "model/list",
      "thread/start",
      "turn/start",
    ],
  );

  const initialize = appServer.requests[0].params;
  assert.equal(initialize.capabilities.experimentalApi, true);

  const threadStart = appServer.requests.find(
    ({ method }) => method === "thread/start",
  ).params;
  assert.equal(threadStart.cwd, workspace);
  assert.equal(threadStart.historyMode, "legacy");
  assert.equal(threadStart.ephemeral, false);
  assert.equal(threadStart.sandbox, "read-only");
  assert.equal(threadStart.approvalPolicy, "never");
  assert.equal(threadStart.model, "gpt-6-sol");

  const planTurn = appServer.requests.find(
    ({ method }) => method === "turn/start",
  ).params;
  assert.equal(planTurn.threadId, "thread-issue-6");
  assert.equal(planTurn.cwd, workspace);
  assert.deepEqual(planTurn.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.equal(planTurn.collaborationMode.mode, "plan");
  assert.equal(planTurn.collaborationMode.settings.model, "gpt-6-sol");
  assert.equal(
    planTurn.collaborationMode.settings.developer_instructions,
    null,
  );
  assert.equal(planTurn.approvalPolicy, "never");
  assert.match(planTurn.input[0].text, /Inspect the repository, create a plan/);
  assert.match(planTurn.input[0].text, /separate unchecked ToDo checklist/);
  assert.match(
    planTurn.input[0].text,
    /Retry transient network\/API\/service failures while the original 24-hour deadline remains, and investigate\/fix code defects, test failures, or review findings instead of retrying them\. Before retrying a non-idempotent write whose outcome is unknown, inspect remote state so an already-applied action is not duplicated\./,
  );
  assert.match(planTurn.input[0].text, /wait for approval/);
  assert.ok(planTurn.input[0].text.includes(issue.url));
  assert.ok(planTurn.input[0].text.includes(issue.body));
  assert.equal(
    appServer.requests.filter(({ method }) => method === "thread/start").length,
    1,
  );
  assert.equal(
    appServer.requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
});

test("Remote reconnects before any Plan thread starts without changing preferences", async () => {
  const client = new FakeAppServer({ remoteStatus: { status: "connecting", installationId: "runner", serverName: "Mac mini" } });
  client.events.unshift(
    { method: "unrelated/notification", params: {} },
    { method: "remoteControl/status/changed", params: { status: "errored", installationId: "runner", serverName: "Mac mini" } },
    { method: "remoteControl/status/changed", params: { status: "connected", installationId: "runner", serverName: "Mac mini", environmentId: null } },
  );
  const nextEvent = client.nextEvent.bind(client);
  let connectionObserved = false;
  client.nextEvent = async () => {
    const event = await nextEvent();
    if (!connectionObserved) assert.equal(client.requests.some(r => r.method === "thread/start"), false);
    if (event.method === "remoteControl/status/changed" && event.params.status === "connected") connectionObserved = true;
    return event;
  };
  const result = await startIssuePlanTurn(client, { workspace, issue });
  assert.equal(connectionObserved, true);
  assert.equal(result.plan, planText);
  assert.deepEqual(client.requests.filter(r => r.method.startsWith("remoteControl/")).map(r => r.method), ["remoteControl/status/read"]);
});

test("disabled or malformed Remote status prevents Plan startup", async () => {
  for (const remoteStatus of [
    { status: "disabled", installationId: "runner", serverName: "Mac mini" },
    { status: "unknown", installationId: "runner", serverName: "Mac mini" },
    { status: "connected", serverName: "Mac mini" },
    { status: "connected", installationId: "runner", serverName: 7 },
    { status: "connected", installationId: "runner", serverName: "Mac mini", environmentId: 7 },
    null,
  ]) {
    for (const source of ["read", "notification"]) {
      const client = new FakeAppServer({ remoteStatus: source === "read" ? remoteStatus : { status: "connecting", installationId: "runner", serverName: "Mac mini" } });
      if (source === "notification") client.events.unshift({ method: "remoteControl/status/changed", params: remoteStatus });
      await assert.rejects(startIssuePlanTurn(client, { workspace, issue }), /Remote/);
      assert.equal(client.requests.some(r => r.method === "thread/start"), false);
    }
  }
});

test("Remote read and event waits stop on deadline or client loss before starting Plan", async () => {
  for (const stage of ["read", "event"]) {
    for (const cancellation of ["deadline", "client"]) {
      const client = new FakeAppServer({ remoteStatus: { status: "connecting", installationId: "runner", serverName: "Mac mini" } });
      let resolveWait;
      let entered;
      const waiting = new Promise(resolve => { entered = resolve; });
      const wait = () => new Promise(resolve => { resolveWait = resolve; entered(); });
      if (stage === "read") {
        const request = client.request.bind(client);
        client.request = (method, params) => method === "remoteControl/status/read" ? wait() : request(method, params);
      } else client.nextEvent = wait;
      const error = new Error("Remote test cancellation");
      let rejectDeadline;
      let rejectClient;
      const deadline = { expired: false, error, expiration: new Promise((resolve, reject) => { rejectDeadline = reject; }) };
      client.failure = new Promise((resolve, reject) => { rejectClient = reject; });
      deadline.expiration.catch(() => {});
      client.failure.catch(() => {});
      const startup = startIssuePlanTurn(client, { workspace, issue, deadline });
      const failed = assert.rejects(startup, value => value === error);
      failed.catch(() => {});
      await Promise.race([waiting, startup.then(() => { throw new Error("Plan started without waiting for Remote"); })]);
      if (cancellation === "deadline") { deadline.expired = true; rejectDeadline(error); }
      else rejectClient(error);
      await failed;
      const connected = { status: "connected", installationId: "runner", serverName: "Mac mini" };
      resolveWait(stage === "read" ? connected : { method: "remoteControl/status/changed", params: connected });
      await Promise.resolve();
      assert.equal(client.requests.some(r => r.method === "thread/start"), false);
    }
  }
});

function terminalTurn(id, status, codexErrorInfo) {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-issue-6",
      turn: {
        id, status,
        ...(status === "failed" ? { error: {
          message: "upstream failed",
          ...(codexErrorInfo === undefined ? {} : { codexErrorInfo }),
        } } : {}),
      },
    },
  };
}

function planItem(turnId, text) {
  return {
    method: "item/completed",
    params: { threadId: "thread-issue-6", turnId, item: { type: "plan", text } },
  };
}

test("retries confirmed transient Plan failures in the same read-only thread", async () => {
  for (const info of [
    { httpConnectionFailed: { httpStatusCode: 503 } },
    { httpConnectionFailed: { httpStatusCode: null } },
    { responseStreamDisconnected: { httpStatusCode: null } },
    { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    "serverOverloaded",
    "rateLimitExceeded",
    "internalServerError",
    { responseStreamConnectionFailed: { httpStatusCode: 408 } },
    { responseStreamConnectionFailed: { httpStatusCode: null } },
  ]) {
    const client = new FakeAppServer({
      turnIds: ["attempt-1", "attempt-2"],
      events: [
        planItem("attempt-1", "incomplete first plan"),
        terminalTurn("attempt-1", "failed", info),
        planItem("attempt-2", "verified second plan"),
        terminalTurn("attempt-2", "completed"),
      ],
    });
    const delays = [];
    const result = await startIssuePlanTurn(client, {
      workspace, issue, waitBeforeRetry: async (ms) => { delays.push(ms); },
    });
    assert.equal(result.plan, "verified second plan");
    assert.equal(result.turnId, "attempt-2");
    assert.equal(result.threadId, "thread-issue-6");
    assert.deepEqual(delays, [1000]);
    assert.equal(client.requests.filter((r) => r.method === "thread/start").length, 1);
    const turns = client.requests.filter((r) => r.method === "turn/start");
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.equal(turn.params.threadId, "thread-issue-6");
      assert.equal(turn.params.collaborationMode.mode, "plan");
      assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    }
  }
});

test("does not start another turn while app-server internally retries", async () => {
  const client = new FakeAppServer({ events: [
    { method: "error", params: {
      threadId: "thread-issue-6", turnId: "turn-plan", willRetry: true,
      error: { message: "retrying upstream", codexErrorInfo: "serverOverloaded" },
    } },
    planItem("turn-plan", planText),
    terminalTurn("turn-plan", "completed"),
  ] });
  let delays = 0;
  const result = await startIssuePlanTurn(client, {
    workspace, issue, waitBeforeRetry: async () => { delays += 1; },
  });
  assert.equal(result.plan, planText);
  assert.equal(delays, 0);
  assert.equal(client.requests.filter((r) => r.method === "turn/start").length, 1);
});

test("does not retry permanent, unclassified, or interrupted Plan failures", async () => {
  for (const [status, info] of [
    ["failed", "unauthorized"],
    ["failed", { httpConnectionFailed: { httpStatusCode: 401 } }],
    ["failed", { responseTooManyFailedAttempts: { httpStatusCode: null } }],
    ["failed", undefined],
    ["interrupted", "serverOverloaded"],
  ]) {
    const client = new FakeAppServer({ events: [terminalTurn("turn-plan", status, info)] });
    let delays = 0;
    await assert.rejects(startIssuePlanTurn(client, {
      workspace, issue, waitBeforeRetry: async () => { delays += 1; },
    }), new RegExp(`status ${status}`));
    assert.equal(delays, 0);
    assert.equal(client.requests.filter((r) => r.method === "turn/start").length, 1);
  }
});

test("retries Plan failures beyond three attempts until a final Plan succeeds", async () => {
  const failed = Array.from({ length: 8 }, (_, index) => `attempt-${index + 1}`);
  const client = new FakeAppServer({
    turnIds: [...failed, "final-attempt"],
    events: [
      ...failed.map(id => terminalTurn(id, "failed", "serverOverloaded")),
      planItem("final-attempt", planText),
      terminalTurn("final-attempt", "completed"),
    ],
  });
  const delays = [];
  const result = await startIssuePlanTurn(client, {
    workspace,
    issue,
    waitBeforeRetry: async ms => delays.push(ms),
  });

  assert.equal(result.plan, planText);
  assert.equal(result.turnId, "final-attempt");
  assert.equal(client.requests.filter(call => call.method === "thread/start").length, 1);
  const turns = client.requests.filter(call => call.method === "turn/start");
  assert.equal(turns.length, 9);
  assert.equal(turns.every(call =>
    call.params.threadId === "thread-issue-6" && call.params.collaborationMode.mode === "plan"), true);
  for (const call of turns) {
    assert.deepEqual(call.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test("absolute deadline stops Plan retries after several failed attempts without another turn", async () => {
  const ids = Array.from({ length: 5 }, (_, index) => `attempt-${index + 1}`);
  const client = new FakeAppServer({
    turnIds: ids,
    events: ids.map(id => terminalTurn(id, "failed", "serverOverloaded")),
  });
  const deadline = { expired: false, error: null };
  const delays = [];
  await assert.rejects(startIssuePlanTurn(client, {
    workspace,
    issue,
    deadline,
    waitBeforeRetry: async ms => {
      delays.push(ms);
      if (delays.length === 5) {
        deadline.expired = true;
        deadline.error = new Error("absolute deadline expired");
      }
    },
  }), /absolute deadline expired/);

  assert.equal(client.requests.filter(call => call.method === "thread/start").length, 1);
  assert.equal(client.requests.filter(call => call.method === "turn/start").length, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
});

test("does not replay an ambiguously failed turn-start RPC", async () => {
  const rpcError = new Error("upstream HTTP 503 while starting turn");
  rpcError.code = -32000;
  const client = new FakeAppServer({ turnStartError: rpcError });
  let waits = 0;
  await assert.rejects(startIssuePlanTurn(client, {
    workspace, issue, waitBeforeRetry: async () => { waits += 1; },
  }), (error) => error === rpcError);
  assert.equal(waits, 0);
  assert.equal(client.requests.filter((r) => r.method === "turn/start").length, 1);
});

test("does not reuse a failed attempt's Plan when a retry has no final Plan", async () => {
  const client = new FakeAppServer({
    turnIds: ["attempt-1", "attempt-2"],
    events: [
      planItem("attempt-1", "stale plan"),
      terminalTurn("attempt-1", "failed", "serverOverloaded"),
      terminalTurn("attempt-2", "completed"),
    ],
  });
  await assert.rejects(startIssuePlanTurn(client, {
    workspace, issue, waitBeforeRetry: async () => {},
  }), /without a concrete plan/);
  assert.equal(client.requests.filter((r) => r.method === "turn/start").length, 2);
});

test("accepts valid final pages when the app-server omits nextCursor", async () => {
  const appServer = new FakeAppServer({
    mcpPages: [{ data: [] }],
    modelPages: [
      {
        data: [{ id: "gpt-6-sol", isDefault: true, hidden: false }],
      },
    ],
  });
  const result = await startIssuePlanTurn(appServer, { workspace, issue });

  assert.equal(result.plan, planText);
});

test("does not start a Plan thread when an MCP write tool is available", async () => {
  const appServer = new FakeAppServer({
    mcpServers: [
      {
        name: "github",
        tools: { create_issue_comment: { description: "Write an issue comment" } },
      },
    ],
  });

  await assert.rejects(
    startIssuePlanTurn(appServer, { workspace, issue }),
    /MCP tools must be disabled during Plan/,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "thread/start"),
    false,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "turn/start"),
    false,
  );
});

test("discovers MCP tools on later pages before starting a Plan thread", async () => {
  const appServer = new FakeAppServer({
    mcpPages: [
      { data: [], nextCursor: "mcp-page-2" },
      {
        data: [
          {
            name: "github",
            tools: { create_issue_comment: { description: "Write a comment" } },
          },
        ],
        nextCursor: null,
      },
    ],
  });
  await assert.rejects(
    startIssuePlanTurn(appServer, { workspace, issue }),
    /MCP tools must be disabled during Plan/,
  );
  assert.equal(
    appServer.requests.filter(({ method }) => method === "mcpServerStatus/list")
      .length,
    2,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "thread/start"),
    false,
  );
});

test("fails closed when MCP tool discovery returns an error", async () => {
  const appServer = new FakeAppServer({
    mcpServers: [
      { name: "github", tools: {}, toolsError: "tool discovery failed" },
    ],
  });
  await assert.rejects(
    startIssuePlanTurn(appServer, { workspace, issue }),
    /MCP tools must be disabled during Plan/,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "thread/start"),
    false,
  );
});

test("fails closed when the app-server does not advertise Plan mode", async () => {
  const appServer = new FakeAppServer({
    modes: [{ name: "Default", mode: "default" }],
  });
  await assert.rejects(
    startIssuePlanTurn(appServer, { workspace, issue }),
    /Plan mode is unavailable/,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "thread/start"),
    false,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "turn/start"),
    false,
  );
});

test("fails before thread creation when no visible default model exists", async () => {
  const appServer = new FakeAppServer({
    modelPages: [
      {
        data: [
          { id: "gpt-6-luna", isDefault: false, hidden: false },
          { id: "gpt-6-sol-hidden", isDefault: true, hidden: true },
        ],
        nextCursor: null,
      },
    ],
  });
  await assert.rejects(
    startIssuePlanTurn(appServer, { workspace, issue }),
    /did not advertise a default model/,
  );
  assert.equal(
    appServer.requests.some(({ method }) => method === "thread/start"),
    false,
  );
});

test("fails a Plan turn that emits a file change or an empty plan", async () => {
  const changedFile = new FakeAppServer({
    events: [
      {
        method: "item/completed",
        params: {
          threadId: "thread-issue-6",
          turnId: "turn-plan",
          item: {
            id: "item-file-change",
            type: "fileChange",
            changes: [{ path: "README.md", kind: "update", diff: "..." }],
          },
        },
      },
    ],
  });
  await assert.rejects(
    startIssuePlanTurn(changedFile, { workspace, issue }),
    /Plan turn must not modify files/,
  );

  const emptyPlan = new FakeAppServer({
    events: [
      {
        method: "item/completed",
        params: {
          threadId: "thread-issue-6",
          turnId: "turn-plan",
          item: { id: "item-plan", type: "plan", text: " \n " },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-issue-6",
          turn: { id: "turn-plan", status: "completed" },
        },
      },
    ],
  });
  await assert.rejects(
    startIssuePlanTurn(emptyPlan, { workspace, issue }),
    /Plan turn completed without a concrete plan/,
  );
});

for (const method of ["mcpServerStatus/list", "model/list"]) {
  for (const cursors of [[""], ["A", "A"], ["A", "B", "A"]]) {
    test(`${method} rejects malformed pagination ${JSON.stringify(cursors)} before another request or Plan`, async () => {
      const client = new FakeAppServer();
      const original = client.request.bind(client);
      let count = 0;
      client.request = async (name, params) => {
        if (name !== method) return original(name, params);
        client.requests.push({ method: name, params });
        count += 1;
        if (count > cursors.length) throw new Error("Fixture page request limit");
        return { data: [], nextCursor: cursors[count - 1] };
      };
      await assert.rejects(startIssuePlanTurn(client, { workspace, issue }), /invalid.*cursor/i);
      assert.equal(count, cursors.length);
      assert.equal(client.requests.some(request => request.method === "thread/start"), false);
      assert.equal(client.requests.some(request => request.method === "turn/start"), false);
    });
  }
}

test("omitted app-server list cursors terminate pagination normally", async () => {
  const client = new FakeAppServer({ mcpPages: [{ data: [] }], modelPages: [{ data: [{ id: "gpt-6-sol", isDefault: true, hidden: false }] }] });
  assert.equal((await startIssuePlanTurn(client, { workspace, issue })).plan, planText);
  assert.equal(client.requests.filter(request => request.method === "mcpServerStatus/list").length, 1);
  assert.equal(client.requests.filter(request => request.method === "model/list").length, 1);
});
