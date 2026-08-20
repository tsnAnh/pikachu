import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  executionMessage,
  localVerifierLaunch,
  parsePlanArgs,
  suggestFanout,
  underlyingModelId,
} from "../agent/extensions/plan-verify/core.ts";
import { gateCandidate } from "../agent/extensions/plan-verify/gate.ts";

test("fan-out suggestion is deterministic and explicit --n parsing stays separate", () => {
  assert.deepEqual(suggestFanout("Fix `agent/settings.json` typo"), {
    n: 1,
    reason: "one focused repository target",
  });
  assert.equal(suggestFanout("Migrate the database API and deployment integration safely").n, 5);
  assert.deepEqual(parsePlanArgs("--n 4 add a verified planner"), {
    n: 4,
    task: "add a verified planner",
  });
  assert.equal(underlyingModelId("openai-codex/gpt-5.6-sol"), "gpt-5.6-sol");
});

test("local verifier launch follows the configured planner model", () => {
  assert.deepEqual(
    localVerifierLaunch("http://127.0.0.1:8899", path.join(process.cwd(), "agent"), "openai-codex/gpt-5.6-sol"),
    {
      projectDir: path.join(process.cwd(), "scripts", "verifier"),
      host: "127.0.0.1",
      port: 8899,
      model: "gpt-5.6-sol",
    },
  );
  assert.equal(
    localVerifierLaunch("https://verifier.example.com", path.join(process.cwd(), "agent"), "provider/model"),
    undefined,
  );
});

test("custom score entries stay out of Pi model context", async () => {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const modulePath = path.join(
    globalRoot,
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "session-manager.js",
  );
  const { SessionManager } = await import(pathToFileURL(modulePath).href);
  const session = SessionManager.inMemory(process.cwd());
  const scoreMarker = "VERIFIER_SCORE_A19T_0.731";
  const selectedPlan = "Inspect the existing seam, make the narrow change, and run its check.";
  session.appendCustomEntry("plan-verify-result", { score: scoreMarker });
  session.appendCustomMessageEntry("plan-execution", executionMessage(selectedPlan), false);
  const context = JSON.stringify(session.buildSessionContext());
  assert.equal(context.includes(scoreMarker), false);
  assert.equal(context.includes(selectedPlan), true);
});

test("Gate A visibly rejects a nonexistent symbol", async () => {
  const result = await gateCandidate(
    {
      stance: "minimal",
      plan: "Change a symbol that is not present.",
      references: {
        paths: ["README.md"],
        symbols: [{ path: "README.md", name: "DefinitelyMissingSymbol" }],
        commands: [],
      },
    },
    process.cwd(),
    true,
    async () => ({
      moduleReport: async () => ({}),
      readSymbol: async () => ({ found: false }),
    }),
  );
  assert.deepEqual(result.reasons, ["symbol does not exist: README.md#DefinitelyMissingSymbol"]);
});
