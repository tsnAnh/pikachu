import assert from "node:assert/strict";
import test from "node:test";
import { ActionPolicy } from "../src/policy.js";

test("confirmation receipts are exact, single-use, and resettable", () => {
  const policy = new ActionPolicy();
  const request = { category: "external-communication" as const, action: "Send reply", destination: "example.com", data: "message", session: "s1", target: "button-1" };
  const receipt = policy.issue(request);
  assert.equal(policy.consume(receipt, { ...request, target: "button-2" }), false);
  assert.equal(policy.consume(receipt, request), false, "mismatched consumption burns the receipt");
  const second = policy.issue(request);
  assert.equal(policy.consume(second, request), true);
  assert.equal(policy.consume(second, request), false);
  const third = policy.issue(request);
  policy.reset();
  assert.equal(policy.consume(third, request), false);
});

test("classifies uploads, exports, destructive management, and consequential clicks", () => {
  const policy = new ActionPolicy();
  assert.equal(policy.classify("tab.setInputFiles", ["tab", "ref", ["/tmp/a"]])?.category, "upload");
  assert.equal(policy.classify("tab.export", ["tab", "html"])?.category, "download");
  assert.equal(policy.classify("browser.management", ["tabs", "remove", [1]])?.category, "delete");
  assert.equal(policy.classify("tab.ax.click", ["tab", "ref", { label: "Post comment" }])?.category, "external-communication");
});
