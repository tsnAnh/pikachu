import assert from "node:assert/strict";
import test from "node:test";
import { cuaWindowHandles } from "../src/cua-observation.js";

test("surfaces capture-bound Cua element handles from a filtered MCP observation", () => {
  const details = {
    server: "cua-driver",
    tool: "get_window_state",
    mcpResult: {
      structuredContent: {
        snapshot_id: "s0000001f",
        elements: [{ element_index: 87, element_token: "s0000001f:87" }],
      },
    },
  };
  assert.equal(cuaWindowHandles("mcp", details), "Cua snapshot_id: s0000001f. Element tokens: [87] s0000001f:87.");
});

test("ignores unrelated results and malformed handles", () => {
  const details = {
    server: "cua-driver",
    tool: "get_window_state",
    mcpResult: {
      structuredContent: {
        snapshot_id: "s0000001f",
        elements: [{ element_index: 87, element_token: "s0000001e:87" }],
      },
    },
  };
  assert.equal(cuaWindowHandles("mcp", details), "Cua snapshot_id: s0000001f.");
  assert.equal(cuaWindowHandles("cua-driver_get_window_state", details), undefined);
  assert.equal(cuaWindowHandles("mcp", { ...details, server: "other" }), undefined);
});
