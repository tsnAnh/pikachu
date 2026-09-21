import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_READY_MARKER, extractCompletedPlan, isReadOnlyBash } from "../src/plan-mode-core.js";

test("completed plans require and remove the readiness marker", () => {
  assert.equal(extractCompletedPlan("# Plan\n\nDo the work."), undefined);
  assert.equal(extractCompletedPlan(`# Plan\n\nDo the work.\n\n${PLAN_READY_MARKER}`), "# Plan\n\nDo the work.");
  assert.equal(extractCompletedPlan(PLAN_READY_MARKER), undefined);
});

test("plan shell policy permits inspection pipelines", () => {
  assert.equal(isReadOnlyBash("rg -n 'registerCommand' agent/extensions | head -40"), true);
  assert.equal(isReadOnlyBash("git status --short && git diff -- settings.json"), true);
  assert.equal(isReadOnlyBash("find agent -maxdepth 2 -type f | sort"), true);
  assert.equal(isReadOnlyBash("npm view pi-lens version"), true);
});

test("plan shell policy blocks direct and disguised mutation", () => {
  const blocked = [
    "rm -rf build",
    "ls; rm file",
    "cat source > target",
    "echo $(touch file)",
    "node -e \"require('fs').writeFileSync('x','y')\"",
    "git status && git reset --hard",
    "git diff --output patch.txt",
    "fd config -x rm",
    "find agent -type f -delete",
    "rg --pre 'touch marker' needle",
    "npm install package",
  ];
  for (const command of blocked) assert.equal(isReadOnlyBash(command), false, command);
});
