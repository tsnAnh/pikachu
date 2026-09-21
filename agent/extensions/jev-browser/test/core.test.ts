import assert from "node:assert/strict";
import test from "node:test";
import { boundedError, isPlanMode, MAX_FIELD_TEXT, parseBridgeLine, parseTextModelOutput, safeEnvironment } from "../src/core.js";

test("strict Sol text accepts only one non-empty bounded text property", () => {
  assert.equal(parseTextModelOutput('{"text":"Zurich"}'), "Zurich");
  assert.throws(() => parseTextModelOutput("not json"), /invalid JSON/);
  assert.throws(() => parseTextModelOutput('{"text":""}'), /empty/);
  assert.throws(() => parseTextModelOutput('{"text":"ok","extra":true}'), /exactly/);
  assert.throws(() => parseTextModelOutput(JSON.stringify({ text: "x".repeat(MAX_FIELD_TEXT + 1) })), /exceeded/);
});

test("bridge parser rejects malformed and untyped messages", () => {
  assert.deepEqual(parseBridgeLine('{"type":"progress","actions":1}'), { type: "progress", actions: 1 });
  assert.throws(() => parseBridgeLine("{"), /invalid bridge JSON/);
  assert.throws(() => parseBridgeLine('{"actions":1}'), /invalid bridge message/);
});

test("plan mode follows the latest valid persisted state", () => {
  const enabled = { type: "custom", customType: "pi-cfg-plan-mode-v1", data: { version: 1, enabled: true } };
  const disabled = { type: "custom", customType: "pi-cfg-plan-mode-v1", data: { version: 1, enabled: false } };
  assert.equal(isPlanMode([enabled]), true);
  assert.equal(isPlanMode([enabled, disabled]), false);
  assert.equal(isPlanMode([{ type: "custom", customType: "other", data: { enabled: true } }]), false);
});

test("subprocess environment excludes unrelated credentials", () => {
  const env = safeEnvironment({ HOME: "/tmp/home", PATH: "/bin", TYPESAFE_API_KEY: "typesafe", OPENAI_API_KEY: "secret" });
  assert.deepEqual(env, { HOME: "/tmp/home", PATH: "/bin", TYPESAFE_API_KEY: "typesafe" });
});

test("diagnostics are bounded", () => {
  assert.equal(boundedError("  short  "), "short");
  assert.equal(boundedError("x".repeat(5_000)).length, 4_001);
});
