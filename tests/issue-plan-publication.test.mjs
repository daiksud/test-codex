import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import * as issueFlow from "../.github/scripts/codex-issue.mjs";

const approval = { approvalTurnId: "ui-turn", approvedPlan: "編集済み Plan\n\n1. Add a focused test.\n" };
const body = "<!-- codex-approved-plan:issue-thread:ui-turn -->\n## Approved Codex Plan\n\n" + approval.approvedPlan;
const endpoint = "https://api.github.com/repos/daiksud/test-codex/issues/19/comments";
const env = { GH_TOKEN: "test-only-token" };

function fixture() {
  const controller = new AbortController();
  let rejectExpiration;
  let rejectFailure;
  const expiration = new Promise((resolve, reject) => { rejectExpiration = reject; });
  const failure = new Promise((resolve, reject) => { rejectFailure = reject; });
  expiration.catch(() => {});
  failure.catch(() => {});
  const deadline = { expiration, expired: false, error: null };
  return {
    session: {
      issue: { repository: "daiksud/test-codex", number: 19 },
      threadId: "issue-thread", deadline, signal: controller.signal, client: { failure },
    },
    expire() {
      deadline.expired = true;
      deadline.error = new Error("Issue deadline expired");
      controller.abort(deadline.error);
      rejectExpiration(deadline.error);
    },
    controller, fail: rejectFailure,
  };
}

function comment(text = body, id = 987) {
  return { id, body: text, html_url: `https://github.com/daiksud/test-codex/issues/19#issuecomment-${id}`, user: { login: "github-actions[bot]" } };
}

function expectedReceipt() {
  return {
    id: 987, url: comment().html_url, threadId: "issue-thread",
    approvalTurnId: approval.approvalTurnId, approvedPlan: approval.approvedPlan,
    repository: "daiksud/test-codex", issueNumber: 19,
  };
}

function response(status, data, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => data };
}

function publish(session, options = {}) {
  assert.equal(typeof issueFlow.postApprovedIssuePlan, "function");
  return issueFlow.postApprovedIssuePlan(session, approval, { env, ...options });
}

test("publishes exact approved text with its session identity and scoped token", async () => {
  const fake = fixture();
  const calls = [];
  const result = await publish(fake.session, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return options.method === "POST" ? response(201, comment()) : response(200, []);
    },
  });
  assert.deepEqual(result, expectedReceipt());
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [[endpoint + "?per_page=100&page=1", "GET"], [endpoint, "POST"]]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { body });
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-only-token");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.equal(calls[1].options.headers["X-GitHub-Api-Version"], "2026-03-10");
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
});

test("bounds every API request to five seconds", async () => {
  const fake = fixture();
  const durations = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ms => {
    durations.push(ms);
    return new AbortController().signal;
  };
  try {
    await publish(fake.session, {
      fetchImpl: async (url, options) => options.method === "POST" ? response(201, comment()) : response(200, []),
    });
    assert.deepEqual(durations, [5000, 5000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("checks later pages and reuses only the exact bot-authored Plan", async () => {
  const fake = fixture();
  const calls = [];
  const firstPage = Array.from({ length: 100 }, () => comment("other plan"));
  firstPage[0] = { ...comment(), user: { login: "fixture-user" } };
  const result = await publish(fake.session, {
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      calls.push(url);
      return response(200, calls.length === 1 ? firstPage : [comment()]);
    },
  });
  assert.deepEqual(result, expectedReceipt());
  assert.deepEqual(calls, [endpoint + "?per_page=100&page=1", endpoint + "?per_page=100&page=2"]);
});

test("binds the receipt to the approved text captured before API awaits", async () => {
  const fake = fixture();
  const mutableApproval = { ...approval };
  const result = await issueFlow.postApprovedIssuePlan(fake.session, mutableApproval, {
    env,
    fetchImpl: async (url, options) => {
      if (options.method === "GET") {
        mutableApproval.approvedPlan = "A different unrecorded plan";
        mutableApproval.approvalTurnId = "a-later-turn";
        return response(200, []);
      }
      assert.deepEqual(JSON.parse(options.body), { body });
      return response(201, comment());
    },
  });
  assert.deepEqual(result, expectedReceipt());
});

test("inspects remote state after an uncertain POST instead of posting twice", async () => {
  for (const outcome of ["network failure", "HTTP 503", "HTTP 503 non-JSON body"]) {
    const fake = fixture();
    const methods = [];
    const delays = [];
    const result = await publish(fake.session, {
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        if (options.method === "POST") {
          if (outcome.startsWith("HTTP 503")) {
            const failed = response(503, {});
            if (outcome.endsWith("non-JSON body")) failed.json = async () => { throw new SyntaxError("private invalid response body"); };
            return failed;
          }
          throw new TypeError("fetch failed after sending");
        }
        return response(200, methods.length === 1 ? [] : [comment()]);
      },
      waitBeforeRetry: async ms => { delays.push(ms); },
    });
    assert.equal(result.id, 987);
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
    assert.deepEqual(delays, [1000]);
  }
});

test("retries inspection after an unknown POST until it finds the saved Plan without posting twice", async () => {
  const fake = fixture();
  const methods = [];
  const delays = [];
  const result = await publish(fake.session, {
    fetchImpl: async (url, options) => {
      methods.push(options.method);
      if (options.method === "POST") throw new TypeError("fetch failed after sending");
      if (methods.length === 1) return response(200, []);
      if (methods.length <= 6) return response(503, {});
      return response(200, [comment()]);
    },
    waitBeforeRetry: async ms => { delays.push(ms); },
  });
  assert.deepEqual(result, expectedReceipt());
  assert.deepEqual(methods, ["GET", "POST", "GET", "GET", "GET", "GET", "GET"]);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
});

for (const invalid of [403, "malformed"]) {
  test(`permanent inspection failure after unknown POST (${invalid}) never posts again`, async () => {
    const fake = fixture();
    const methods = [];
    await assert.rejects(publish(fake.session, {
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        if (options.method === "POST") throw new TypeError("fetch failed after sending");
        if (methods.length === 1) return response(200, []);
        return invalid === 403 ? response(403, {}) : response(200, {});
      },
      waitBeforeRetry: async () => {},
    }), /403|inspect/i);
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
  });
}

test("retries an uncertain POST only after inspection confirms no saved Plan", async () => {
  for (const outcome of ["network failure", "HTTP 503"]) {
    const fake = fixture();
    const methods = [];
    const delays = [];
    let posts = 0;
    const result = await publish(fake.session, {
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        if (options.method === "GET") return response(200, []);
        posts += 1;
        if (posts === 1) {
          if (outcome === "HTTP 503") return response(503, {});
          throw new TypeError("fetch failed after sending");
        }
        return response(201, comment());
      }, waitBeforeRetry: async ms => { delays.push(ms); },
    });
    assert.equal(result.id, 987);
    assert.deepEqual(methods, ["GET", "POST", "GET", "POST"]);
    assert.deepEqual(delays, [1000]);
  }
});

test("retries ordinary transient API failures with bounded backoff", async () => {
  for (const status of [408, 500, 502, 503]) {
    const fake = fixture();
    const methods = [];
    const delays = [];
    await publish(fake.session, {
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        return methods.length < 3 ? response(status, {}) : options.method === "POST" ? response(201, comment()) : response(200, []);
      }, waitBeforeRetry: async ms => { delays.push(ms); },
    });
    assert.deepEqual(delays, [1000, 2000]);
    assert.deepEqual(methods, ["GET", "GET", "GET", "POST"]);
  }
});

test("honors GitHub rate-limit timing and retries 403 only with evidence", async () => {
  const now = () => Date.parse("2026-09-27T00:00:00Z");
  const cases = [
    [429, {}, { "retry-after": "7" }, 7000],
    [503, {}, { "retry-after": "Sun, 27 Sep 2026 00:00:09 GMT" }, 9000],
    [403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now() / 1000 + 30) }, 30000],
    [403, { message: "You have exceeded a secondary rate limit." }, {}, 60000],
    [429, {}, {}, 60000],
  ];
  for (const [status, data, headers, delay] of cases) {
    const fake = fixture();
    const delays = [];
    let count = 0;
    await publish(fake.session, {
      now, waitBeforeRetry: async ms => { delays.push(ms); },
      fetchImpl: async (url, options) => ++count === 1 ? response(status, data, headers) : options.method === "POST" ? response(201, comment()) : response(200, []),
    });
    assert.deepEqual(delays, [delay]);
  }
});

test("applies rate-limit and permanent-error handling to POST as well as GET", async () => {
  for (const status of [429, 403]) {
    const fake = fixture();
    const methods = [];
    const delays = [];
    let posts = 0;
    const publication = publish(fake.session, {
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        if (options.method === "GET") return response(200, []);
        posts += 1;
        return posts === 1 ? response(status, {}, status === 429 ? { "retry-after": "11" } : {}) : response(201, comment());
      }, waitBeforeRetry: async ms => { delays.push(ms); },
    });
    if (status === 403) {
      await assert.rejects(publication, /403/);
      assert.deepEqual(methods, ["GET", "POST"]);
      assert.deepEqual(delays, []);
    } else {
      assert.equal((await publication).id, 987);
      assert.deepEqual(methods, ["GET", "POST", "GET", "POST"]);
      assert.deepEqual(delays, [11000]);
    }
  }
});

test("does not retry permanent publication errors", async () => {
  for (const status of [401, 403, 404, 422]) {
    const fake = fixture();
    let count = 0;
    const delays = [];
    await assert.rejects(publish(fake.session, {
      fetchImpl: async () => {
        count += 1;
        return response(status, { message: "private error detail" });
      },
      waitBeforeRetry: async ms => { delays.push(ms); },
    }), error => {
      assert.match(error.message, new RegExp(String(status)));
      assert.equal(error.message.includes("private error detail"), false);
      return true;
    });
    assert.equal(count, 1);
    assert.deepEqual(delays, []);
  }
});

for (const method of ["GET", "POST"]) {
  test(`transient ${method} publication errors continue beyond three attempts until success`, async () => {
    const fake = fixture();
    const methods = [];
    const delays = [];
    let failures = 0;
    const result = await publish(fake.session, {
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        if (options.method === method && failures++ < 8) return response(503, {});
        return options.method === "POST" ? response(201, comment()) : response(200, []);
      },
      waitBeforeRetry: async ms => { delays.push(ms); },
    });
    assert.deepEqual(result, expectedReceipt());
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    if (method === "GET") {
      assert.equal(methods.filter(value => value === "POST").length, 1);
      assert.equal(methods.filter(value => value === "GET").length, 9);
    } else {
      assert.equal(methods.length, 18);
      for (let index = 0; index < methods.length; index += 2) {
        assert.deepEqual(methods.slice(index, index + 2), ["GET", "POST"]);
      }
    }
  });
}

test("original deadline ends transient publication retries without another request", async () => {
  const fake = fixture();
  let count = 0;
  const delays = [];
  await assert.rejects(publish(fake.session, {
    fetchImpl: async () => { count += 1; return response(503, {}); },
    waitBeforeRetry: async ms => {
      delays.push(ms);
      if (delays.length === 5) fake.expire();
    },
  }), /deadline expired/);
  assert.equal(count, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
});

test("rejects missing credentials and invalid comment responses before write permission", async () => {
  const fake = fixture();
  let calls = 0;
  await assert.rejects(publish(fake.session, { env: {}, fetchImpl: async () => { calls += 1; } }), /token/i);
  assert.equal(calls, 0);
  for (const value of [{ ...comment(), body: "different plan" }, { ...comment(), id: null }, { ...comment(), html_url: "https://example.invalid/" }]) {
    await assert.rejects(publish(fake.session, {
      fetchImpl: async (url, options) => options.method === "POST" ? response(201, value) : response(200, []),
      waitBeforeRetry: async () => {},
    }), /comment response/i);
  }
});

test("cancels pending API calls and rate-limit waits at the original deadline", async () => {
  for (const phase of ["request", "backoff"]) {
    const fake = fixture();
    let calls = 0;
    let signal;
    await assert.rejects(publish(fake.session, {
      fetchImpl: async (url, options) => {
        calls += 1;
        signal = options.signal;
        if (phase === "backoff") return response(429, {}, { "retry-after": "120" });
        fake.expire();
        throw options.signal.reason;
      }, waitBeforeRetry: async ms => {
        assert.equal(ms, 120000);
        fake.expire();
      },
    }), /deadline expired/);
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  }
});

test("fails promptly on owned-client loss during API inspection", async () => {
  const fake = fixture();
  let signal;
  const publication = publish(fake.session, {
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        fake.fail(new Error("transport lost"));
      });
    },
  });
  const rejected = assert.rejects(publication, /transport lost/);
  rejected.catch(() => {});
  await setImmediate();
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
  await rejected;
});

test("makes no API call for an already expired Issue", async () => {
  const fake = fixture();
  let calls = 0;
  fake.expire();
  await assert.rejects(publish(fake.session, {
    fetchImpl: async () => { calls += 1; },
  }), /deadline expired/);
  assert.equal(calls, 0);
});

test("huge Retry-After cannot overflow the default timer into an early retry", async () => {
  const fake = fixture();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  let requests = 0;
  let publication;
  globalThis.setTimeout = (callback, delayMs) => {
    const timer = { callback, delayMs, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { timer.cleared = true; };
  try {
    publication = publish(fake.session, {
      fetchImpl: async () => {
        requests += 1;
        return response(503, {}, { "retry-after": "2147484" });
      },
    });
    publication.catch(() => {});
    await setImmediate();
    assert.equal(timers.length, 1);
    assert.ok(timers[0].delayMs > 0 && timers[0].delayMs <= issueFlow.MAX_ISSUE_RUNTIME_MS,
      "default retry timer must stay below the native overflow limit and original Issue budget");
    fake.expire();
    await assert.rejects(publication, /deadline expired/);
    assert.equal(requests, 1);
    assert.equal(timers[0].cleared, true);
  } finally {
    fake.expire();
    await publication?.catch(() => {});
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
