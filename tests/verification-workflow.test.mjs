import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/verify.yml", import.meta.url);

test("branch pushes verify the Node source with a read-only hosted CI job", () => {
  assert.ok(existsSync(workflowPath), "branch pushes need a verification workflow");
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /^on: push$/m);
  assert.doesNotMatch(workflow, /pull_request|workflow_dispatch/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^\s+[\w-]+: write$/m);
  assert.match(workflow, /^defaults:\n  run:\n    shell: bash$/m);
  assert.match(workflow, /^    name: Codex verification$/m);
  assert.match(workflow, /^    runs-on: ubuntu-slim$/m);
  const steps = workflow.split(/^      - /m).slice(1);
  assert.equal(steps.length, 4);
  assert.match(steps[0], /^uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(steps[0], /with:\n          persist-credentials: false/);
  assert.match(steps[1], /^uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(steps[1], /with:\n          node-version: 24\n          package-manager-cache: false/);
  assert.match(steps[2], /^run: node --check \.github\/scripts\/codex-issue\.mjs\s*$/);
  assert.match(steps[3], /^run: node --test tests\/\*\.test\.mjs\s*$/);
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((action) => /@[a-f0-9]{40}$/.test(action)));
  const commands = [...workflow.matchAll(/run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "node --check .github/scripts/codex-issue.mjs",
    "node --test tests/*.test.mjs",
  ]);
});
