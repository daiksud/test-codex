import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const workspace = "/runner/_work/test-codex/test-codex";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdinWrites = [];
    this.stdin.on("data", (value) => this.stdinWrites.push(value.toString()));
    this.stdout = new PassThrough();
    this.killedWith = [];
  }

  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }
}

function fakeSpawner() {
  const children = [];
  const calls = [];
  return {
    children,
    calls,
    spawnProcess: (command, args, options) => {
      const child = new FakeChild();
      children.push(child);
      calls.push({ command, args, options });
      return child;
    },
  };
}

function requireAppServerFactory() {
  assert.equal(
    typeof issueFlow.spawnCodexAppServer,
    "function",
    "the Issue flow must expose its app-server process adapter",
  );
  return issueFlow.spawnCodexAppServer;
}

function requireFailureSignal(client) {
  assert.ok(client.failure instanceof Promise, "client must expose an unexpected-failure Promise");
  return client.failure;
}

test("spawns a job-owned app-server with process-scoped MCP overrides", () => {
  const spawnCodexAppServer = requireAppServerFactory();
  const fake = fakeSpawner();
  const existingCodexHome = process.env.CODEX_HOME;

  const client = spawnCodexAppServer({ workspace, spawnProcess: fake.spawnProcess });

  assert.deepEqual(fake.calls, [
    {
      command: "codex",
      args: [
        "app-server",
        "--stdio",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "-c",
        "mcp_servers.computer-use.enabled=false",
        "-c",
        "mcp_servers.node_repl.enabled=false",
      ],
      options: { cwd: workspace, stdio: ["pipe", "pipe", "inherit"] },
    },
  ]);
  assert.equal(process.env.CODEX_HOME, existingCodexHome);
  assert.equal(fake.children[0].stdinWrites.length, 0);
  client.close();
});

test("correlates out-of-order JSONL responses and preserves interleaved events", async () => {
  const spawnCodexAppServer = requireAppServerFactory();
  const fake = fakeSpawner();
  const client = spawnCodexAppServer({ workspace, spawnProcess: fake.spawnProcess });
  const child = fake.children[0];

  const firstResponse = client.request("first", { value: 1 });
  const secondResponse = client.request("second", { value: 2 });
  const firstEvent = client.nextEvent();
  client.notify("initialized", {});

  const sentMessages = child.stdinWrites.map((line) => JSON.parse(line));
  assert.deepEqual(
    sentMessages.map(({ method }) => method),
    ["first", "second", "initialized"],
  );
  assert.equal("id" in sentMessages[2], false);

  const secondMessage = JSON.stringify({
    id: sentMessages[1].id,
    result: { value: "second result" },
  });
  const firstEventMessage = JSON.stringify({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", sequence: 1 },
  });
  const secondEventMessage = JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", sequence: 2 },
  });
  const firstMessage = JSON.stringify({
    id: sentMessages[0].id,
    result: { value: "first result" },
  });

  child.stdout.write(secondMessage.slice(0, 9));
  child.stdout.write(
    `${secondMessage.slice(9)}\n${firstEventMessage}\n${secondEventMessage}\n${firstMessage}\n`,
  );

  assert.deepEqual(await firstResponse, { value: "first result" });
  assert.deepEqual(await secondResponse, { value: "second result" });
  assert.deepEqual(await firstEvent, {
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", sequence: 1 },
  });
  assert.deepEqual(await client.nextEvent(), {
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", sequence: 2 },
  });
  client.close();
});

test("rejects a request cleanly when writing to app-server stdin fails", async () => {
  const spawnCodexAppServer = requireAppServerFactory();
  const fake = fakeSpawner();
  const client = spawnCodexAppServer({ workspace, spawnProcess: fake.spawnProcess });
  fake.children[0].stdin.write = () => {
    throw new Error("stdin write failed");
  };

  await assert.rejects(client.request("write-failure"), /stdin write failed/);
  client.close();
});

test("close kills only the child process owned by that client", () => {
  const spawnCodexAppServer = requireAppServerFactory();
  const fake = fakeSpawner();
  const firstClient = spawnCodexAppServer({
    workspace,
    spawnProcess: fake.spawnProcess,
  });
  const secondClient = spawnCodexAppServer({
    workspace,
    spawnProcess: fake.spawnProcess,
  });

  firstClient.close();

  assert.deepEqual(fake.children[0].killedWith, ["SIGTERM"]);
  assert.deepEqual(fake.children[1].killedWith, []);
  secondClient.close();
});

for (const failure of ["exit", "stdout end"]) {
  test(`signals unexpected ${failure} even without an active request`, async () => {
    const fake = fakeSpawner();
    const client = issueFlow.spawnCodexAppServer({ workspace, spawnProcess: fake.spawnProcess });
    try {
      const signal = requireFailureSignal(client);
      if (failure === "exit") fake.children[0].emit("exit", 1, null);
      else fake.children[0].stdout.end();
      await assert.rejects(signal, /app-server (exited|closed its output stream)/);
    } finally {
      client.close();
    }
  });
}

test("deliberate client close does not signal an unexpected failure", async () => {
  const fake = fakeSpawner();
  const client = issueFlow.spawnCodexAppServer({ workspace, spawnProcess: fake.spawnProcess });
  let unexpectedFailure = false;
  requireFailureSignal(client).catch(() => { unexpectedFailure = true; });
  client.close();
  fake.children[0].stdout.end();
  fake.children[0].emit("exit", null, "SIGTERM");
  await setImmediate();
  assert.equal(unexpectedFailure, false);
});

for (const id of [0, "question-1"]) {
  test(`rejects an unsupported server request with id ${id}`, async () => {
    const fake = fakeSpawner();
    const client = issueFlow.spawnCodexAppServer({ workspace, spawnProcess: fake.spawnProcess });
    const nextEvent = client.nextEvent();
    try {
      fake.children[0].stdout.write(`${JSON.stringify({
        id,
        method: "item/tool/requestUserInput",
        params: { threadId: "thread-1", turnId: "turn-1" },
      })}\n`);
      await assert.rejects(nextEvent, /item\/tool\/requestUserInput.*requires a client response/);
      assert.equal(fake.children[0].stdinWrites.length, 0);
    } finally {
      client.close();
    }
  });
}
