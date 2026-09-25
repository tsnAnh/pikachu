const PREFIX = "cua-driver_";

const WINDOW_INPUT = new Set([
  "click", "double_click", "right_click", "drag", "type_text", "press_key",
  "hotkey", "scroll", "move_cursor", "set_value",
]);

const SAFE_TOOLS = new Set([
  "list_apps", "list_windows", "get_window_state", "get_accessibility_tree",
  "get_desktop_state", "get_screen_size", "get_cursor_position", "get_config",
  "get_recording_state", "get_agent_cursor_state", "check_permissions",
  "health_report", "check_for_update", "get_browser_state", "get_session",
  "list_sessions", "get_session_state", "verify_state", "clipboard_read",
  "browser_click", "browser_dialog", "browser_download", "browser_navigate",
  "browser_pointer", "browser_set_input_files", "browser_type", "end_session",
  "start_session", "start_recording", "stop_recording", "zoom",
  ...WINDOW_INPUT,
]);

type Input = Record<string, unknown>;

function isRecord(value: unknown): value is Input {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWindowTarget(args: Input): boolean {
  const target = args.target;
  if (isRecord(target)) {
    return target.kind === "window" && Number.isInteger(target.pid) && Number.isInteger(target.window_id);
  }
  return Number.isInteger(args.pid) && Number.isInteger(args.window_id);
}

/** Mutates tool arguments only after proving the call uses a background window route. */
export function protectCuaToolCall(toolName: string, input: Input): string | undefined {
  if (toolName === "mcpScript") {
    return "MCP scripting is unavailable while Cua Driver focus protection is on because nested calls cannot be checked.";
  }
  let name: string;
  let args: Input;
  if (toolName.startsWith(PREFIX)) {
    name = toolName.slice(PREFIX.length);
    args = input;
  } else if (toolName === "mcp" && typeof input.tool === "string" && input.tool.startsWith(PREFIX)) {
    name = input.tool.slice(PREFIX.length);
    let parsed: unknown;
    try {
      parsed = typeof input.args === "string" ? JSON.parse(input.args) : input.args ?? {};
    } catch {
      return "Cua Driver arguments must be a valid JSON object.";
    }
    if (!isRecord(parsed)) return "Cua Driver arguments must be a JSON object.";
    args = parsed;
  } else {
    return undefined;
  }

  if (!SAFE_TOOLS.has(name)) return `Cua Driver ${name} may interrupt the desktop and is blocked by default.`;
  if (args.delivery_mode !== undefined && args.delivery_mode !== "background") {
    return "Foreground Cua Driver delivery is blocked by default.";
  }
  if (args.scope === "desktop" || args.capture_scope === "desktop" || args.display_id !== undefined ||
    (isRecord(args.target) && args.target.kind !== "window")) {
    return "Desktop-wide Cua Driver input is blocked by default.";
  }
  if (WINDOW_INPUT.has(name)) {
    if (!isWindowTarget(args)) return "Cua Driver input needs an exact pid and window_id for background use.";
    args.delivery_mode = "background";
  }
  if (toolName === "mcp") input.args = args;
  return undefined;
}
