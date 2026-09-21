export type DelegationMode = "auto" | "herdr" | "subagents" | "both";

export function resolveDelegationTools(
  mode: DelegationMode,
  available: ReadonlySet<string>,
): { tools: string[]; fallback?: string } {
  const hasHerdr = available.has("herdr");
  const hasSubagents = available.has("subagent");
  if (mode === "auto") {
    if (hasHerdr) return { tools: ["herdr"] };
    if (hasSubagents) return { tools: ["subagent"] };
    return { tools: [] };
  }
  if (mode === "herdr") {
    if (hasHerdr) return { tools: ["herdr"] };
    return { tools: hasSubagents ? ["subagent"] : [], fallback: "Herdr is unavailable; using subagents." };
  }
  if (mode === "subagents") {
    return hasSubagents ? { tools: ["subagent"] } : { tools: [], fallback: "pi-subagents is unavailable." };
  }
  const tools = [hasHerdr ? "herdr" : undefined, hasSubagents ? "subagent" : undefined].filter(
    (value): value is string => Boolean(value),
  );
  return { tools, fallback: tools.length < 2 ? "One requested delegation tool is unavailable." : undefined };
}
