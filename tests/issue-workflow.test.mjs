import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/codex-issue.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

function blockAtIndent(source, indent, key) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}${key}:`);
  assert.notEqual(start, -1, `missing ${key} section`);

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const lineIndent = line.match(/^ */)[0].length;
    if (line.trim() !== "" && lineIndent <= indent) break;
    end += 1;
  }

  return lines.slice(start, end).join("\n");
}

test("Issue processing uses an author guard and job-level concurrency", () => {
  assert.match(workflow, /^on:\n  issues:\n    types: \[opened\]$/m);

  const jobs = blockAtIndent(workflow, 0, "jobs");
  const processingJob = blockAtIndent(jobs, 2, "codex");

  assert.match(
    processingJob,
    /^    if:[ \t]*\$\{\{[ \t]*github\.event\.issue\.user\.login[ \t]*==[ \t]*'daiksud'[ \t]*\}\}[ \t]*$/m,
  );
  assert.match(processingJob, /^    concurrency:\n/m);
  assert.doesNotMatch(workflow, /^concurrency:\n/m);
});

test("the Codex job timeout matches the 24-hour cap", () => {
  const jobs = blockAtIndent(workflow, 0, "jobs");
  const processingJob = blockAtIndent(jobs, 2, "codex");

  assert.match(processingJob, /^    timeout-minutes: 1440$/m);
});

test("Codex starts from a clean main checkout in the default workspace", () => {
  const jobs = blockAtIndent(workflow, 0, "jobs");
  const processingJob = blockAtIndent(jobs, 2, "codex");
  const steps = blockAtIndent(processingJob, 4, "steps");
  const stepLines = steps.split("\n");
  const firstStepIndex = stepLines.findIndex((line) => line.startsWith("      - "));
  assert.notEqual(firstStepIndex, -1, "Codex job must have a first step");
  const nextStepIndex = stepLines.findIndex(
    (line, index) => index > firstStepIndex && line.startsWith("      - "),
  );
  const checkoutStep = stepLines
    .slice(firstStepIndex, nextStepIndex === -1 ? undefined : nextStepIndex)
    .join("\n");

  assert.match(
    stepLines[firstStepIndex],
    /^      - uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803(?:[ \t]+# v6)?$/,
  );
  assert.match(checkoutStep, /^        with:\n/m);
  assert.match(checkoutStep, /^          ref: main$/m);
  assert.match(checkoutStep, /^          clean: true$/m);
  assert.match(checkoutStep, /^          persist-credentials: true$/m);
  assert.doesNotMatch(checkoutStep, /^\s+path:/m);
  assert.doesNotMatch(checkoutStep, /worktree/i);

  const defaults = blockAtIndent(workflow, 0, "defaults");
  const run = blockAtIndent(defaults, 2, "run");
  assert.match(run, /^  run:\n    shell: bash$/m);
});

test("the self-hosted job provisions Node 24 before invoking the Plan CLI", () => {
  const jobs = blockAtIndent(workflow, 0, "jobs");
  const processingJob = blockAtIndent(jobs, 2, "codex");
  const steps = blockAtIndent(processingJob, 4, "steps").split(/^      - /m).slice(1);

  assert.equal(steps.length, 3);
  assert.match(steps[0], /^uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(steps[1], /^uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(steps[1], /with:\n          node-version: 24\n          package-manager-cache: false/);
  assert.doesNotMatch(steps[1], /^\s+cache:/m);
  assert.match(steps[2], /^name: Start Codex Plan\n        run: node /);
});

test("the guarded job launches the Plan CLI with scoped write permissions", () => {
  const jobs = blockAtIndent(workflow, 0, "jobs");
  const processingJob = blockAtIndent(jobs, 2, "codex");
  const permissions = blockAtIndent(processingJob, 4, "permissions");

  assert.match(permissions, /^    permissions:\n/m);
  const permissionEntries = permissions
    .split(/\r?\n/)
    .filter((line) => line.startsWith("      "))
    .map((line) => line.trim());
  assert.deepEqual(permissionEntries, [
    "checks: read",
    "contents: write",
    "issues: write",
    "pull-requests: write",
    "statuses: write",
  ]);

  const steps = blockAtIndent(processingJob, 4, "steps");
  assert.match(steps, /^      - name: Start Codex Plan$/m);
  const planStepStart = steps.indexOf("      - name: Start Codex Plan");
  const planStep = steps.slice(planStepStart);
  assert.match(planStep, /^        run: node \.github\/scripts\/codex-issue\.mjs$/m);
  assert.match(planStep, /^        env:\n          GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.ok(
    steps.indexOf("      - uses: actions/checkout@") < planStepStart,
    "the checkout must precede the Plan CLI step",
  );
});
