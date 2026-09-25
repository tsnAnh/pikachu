type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Surface only capture-bound AX handles needed for a safe follow-up action. */
export function cuaWindowHandles(toolName: string, details: unknown): string | undefined {
  if (toolName !== "mcp") return undefined;
  const metadata = record(details);
  if (metadata?.server !== "cua-driver" || metadata.tool !== "get_window_state") return undefined;
  const structured = record(record(metadata.mcpResult)?.structuredContent);
  const snapshotId = structured?.snapshot_id;
  if (typeof snapshotId !== "string" || !/^s[0-9a-f]{8}$/.test(snapshotId)) return undefined;
  const elements = structured?.elements;
  if (!Array.isArray(elements)) return `Cua snapshot_id: ${snapshotId}.`;
  if (elements.length > 40) return `Cua snapshot_id: ${snapshotId}. Narrow get_window_state with query to receive element tokens.`;
  const handles = elements.flatMap((value) => {
    const element = record(value);
    const index = element?.element_index;
    const token = element?.element_token;
    if (!Number.isInteger(index) || typeof token !== "string" || token !== `${snapshotId}:${index}`) return [];
    return [`[${index}] ${token}`];
  });
  return `Cua snapshot_id: ${snapshotId}.${handles.length ? ` Element tokens: ${handles.join(", ")}.` : ""}`;
}
