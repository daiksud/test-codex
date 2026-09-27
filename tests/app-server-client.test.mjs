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

test("spawns a job-owned app-server without inventing MCP entries", () => {
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
      ],
      options: { cwd: workspace, stdio: ["pipe", "pipe", "inherit"] },
    },
  ]);
  assert.equal(process.env.CODEX_HOME, existingCodexHome);
  assert.equal(fake.children[0].stdinWrites.length, 0);
  client.close();
});

test("disables only discovered MCP names with literal inline-table keys", () => {
  const fake = fakeSpawner();
  const client = requireAppServerFactory()({
    workspace, spawnProcess: fake.spawnProcess,
    mcpServerNames: ["computer-use", "name.with.dot", 'quoted"name'],
  });
  assert.deepEqual(fake.calls[0].args.slice(6), [
    "-c",
    'mcp_servers={"computer-use"={enabled=false},"name.with.dot"={enabled=false},"quoted\\"name"={enabled=false}}',
  ]);
  client.close();
});

test("discovers configured MCP entries without exposing their settings", async () => {
  assert.equal(typeof issueFlow.createCodexAppServer, "function");
  for (const names of [[], ["computer-use", "node_repl"]]) {
    const fake = fakeSpawner();
    const signal = new AbortController().signal;
    const client = await issueFlow.createCodexAppServer({
      workspace, signal, spawnProcess: fake.spawnProcess,
      executeFile: async (command, args, options) => {
        assert.equal(command, "codex");
        assert.deepEqual(args, ["--disable", "apps", "--disable", "plugins", "mcp", "list", "--json"]);
        assert.equal(options.cwd, workspace);
        assert.equal(options.signal, signal);
        assert.equal(options.timeout, 10000);
        assert.equal(options.maxBuffer, 1024 * 1024);
        return { stdout: JSON.stringify(names.map(name => ({ name, enabled: true, secret: "private-setting" }))) };
      },
    });
    assert.equal(fake.calls.length, 1);
    const overrides = fake.calls[0].args.slice(6);
    assert.deepEqual(overrides, names.length ? ["-c", 'mcp_servers={"computer-use"={enabled=false},"node_repl"={enabled=false}}'] : []);
    assert.equal(JSON.stringify(fake.calls).includes("private-setting"), false);
    client.close();
  }
});

test("fails closed without spawning on invalid or failed MCP discovery", async () => {
  assert.equal(typeof issueFlow.createCodexAppServer, "function");
  for (const value of ["invalid-json", "{}", '[{"name":""}]', '[{"enabled":true}]', new Error("private-setting")]) {
    const fake = fakeSpawner();
    await assert.rejects(issueFlow.createCodexAppServer({
      workspace, spawnProcess: fake.spawnProcess,
      executeFile: async () => {
        if (value instanceof Error) throw value;
        return { stdout: value };
      },
    }), error => {
      assert.match(error.message, /MCP configuration/);
      assert.equal(error.message.includes("private-setting"), false);
      return true;
    });
    assert.equal(fake.calls.length, 0);
  }
});

test("does not spawn after MCP discovery finishes past cancellation", async () => {
  assert.equal(typeof issueFlow.createCodexAppServer, "function");
  const fake = fakeSpawner();
  const controller = new AbortController();
  const reason = new Error("Issue expired");
  await assert.rejects(issueFlow.createCodexAppServer({
    workspace, signal: controller.signal, spawnProcess: fake.spawnProcess,
    executeFile: async () => {
      controller.abort(reason);
      return { stdout: "[]" };
    },
  }), error => error === reason);
  assert.equal(fake.calls.length, 0);
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

test("preserves Japanese Plan text across byte-split UTF-8 JSONL messages", async () => {
  const text = "日本語の計画 é 🌏";
  const expectedEvent = {
    method: "item/completed",
    params: { item: { type: "plan", text } },
  };
  const check = async (response, event) => {
    assert.deepEqual(await response, { text });
    assert.deepEqual(await event, expectedEvent);
  };
  const fake = fakeSpawner();
  const client = requireAppServerFactory()({ workspace, spawnProcess: fake.spawnProcess });
  try {
    const response = client.request("thread/read");
    const event = client.nextEvent();
    const { id } = JSON.parse(fake.children[0].stdinWrites[0]);
    const bytes = Buffer.from(
      `${JSON.stringify({ id, result: { text } })}\n${JSON.stringify(expectedEvent)}\n`,
      "utf8",
    );
    for (let index = 0; index < bytes.length; index += 1) {
      fake.children[0].stdout.write(bytes.subarray(index, index + 1));
    }
    await check(response, event);
  } finally {
    client.close();
  }
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
