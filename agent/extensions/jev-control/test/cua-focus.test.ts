import assert from "node:assert/strict";
import test from "node:test";
import { protectCuaToolCall } from "../src/cua-focus.js";

test("window actions are explicitly pinned to background delivery", () => {
  const input: Record<string, unknown> = { pid: 30205, window_id: 5563, keys: ["cmd", "l"] };
  assert.equal(protectCuaToolCall("cua-driver_hotkey", input), undefined);
  assert.equal(input.delivery_mode, "background");

  const gateway: Record<string, unknown> = {
    tool: "cua-driver_click",
    args: JSON.stringify({ pid: 30205, window_id: 5563, x: 100, y: 200 }),
  };
  assert.equal(protectCuaToolCall("mcp", gateway), undefined);
  assert.equal((gateway.args as Record<string, unknown>).delivery_mode, "background");
});

test("foreground and desktop-wide calls are blocked on direct and gateway paths", () => {
  assert.match(
    protectCuaToolCall("cua-driver_hotkey", { pid: 30205, window_id: 5563, keys: ["cmd", "l"], delivery_mode: "foreground" }) ?? "",
    /Foreground/,
  );
  assert.match(
    protectCuaToolCall("mcp", { tool: "cua-driver_click", args: { scope: "desktop", x: 100, y: 200 } }) ?? "",
    /Desktop-wide/,
  );
  assert.match(
    protectCuaToolCall("cua-driver_click", { target: { kind: "desktop", display_id: "primary" }, x: 100, y: 200 }) ?? "",
    /Desktop-wide/,
  );
  assert.match(protectCuaToolCall("cua-driver_press_key", { key: "return" }) ?? "", /exact pid and window_id/);
});

test("focus-changing tools and unrecognized Cua tools fail closed", () => {
  for (const name of ["bring_to_front", "launch_app", "clipboard_write", "browser_prepare", "replay_trajectory", "future_tool"]) {
    assert.match(protectCuaToolCall(`cua-driver_${name}`, {}) ?? "", /blocked by default/);
  }
  assert.match(protectCuaToolCall("mcp", { tool: "cua-driver_click", args: "{" }) ?? "", /valid JSON object/);
  assert.match(protectCuaToolCall("mcpScript", { code: "await tools.search({query: 'computer'})" }) ?? "", /nested calls/);
});

test("inspection and unrelated MCP calls remain available", () => {
  const inspect: Record<string, unknown> = { tool: "cua-driver_list_windows" };
  assert.equal(protectCuaToolCall("mcp", inspect), undefined);
  assert.deepEqual(inspect.args, {});
  assert.equal(protectCuaToolCall("cua-driver_get_window_state", { pid: 30205, window_id: 5563 }), undefined);
  assert.equal(protectCuaToolCall("mcp", { tool: "trello_list_boards" }), undefined);
});
