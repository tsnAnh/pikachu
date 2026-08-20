import path from "node:path";

export interface FanoutSuggestion {
  n: 1 | 3 | 5;
  reason: string;
}

export interface ParsedPlanArgs {
  n?: number;
  task: string;
}

const HIGH_RISK =
  /\b(auth(?:entication|orization)?|security|permission|migration|schema|data[- ]?contract|concurren(?:cy|t)|race condition|deploy(?:ment)?|compatib(?:ility|le)|integration)\b/i;

const SUBSYSTEMS = [
  "api",
  "backend",
  "cache",
  "cli",
  "config",
  "database",
  "extension",
  "frontend",
  "model",
  "package",
  "persistence",
  "service",
  "session",
];

export function explicitReferences(task: string): string[] {
  const values = new Set<string>();
  for (const match of task.matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (/^[\w.$@/-]+(?::\d+)?$/.test(value)) values.add(value);
  }
  for (const match of task.matchAll(/(?:^|\s)((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.@-]+)+(?:\.[\w-]+)?)/g)) {
    values.add(match[1]);
  }
  return [...values];
}

export function suggestFanout(task: string): FanoutSuggestion {
  const references = explicitReferences(task).length;
  const subsystemCount = SUBSYSTEMS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(task)).length;
  if (HIGH_RISK.test(task) || references >= 3 || subsystemCount >= 3 || task.length > 800) {
    return { n: 5, reason: "cross-system or high-risk task" };
  }
  if (task.length <= 240 && references === 1 && subsystemCount < 2) {
    return { n: 1, reason: "one focused repository target" };
  }
  return { n: 3, reason: "moderate or not-yet-localized task" };
}

export function parsePlanArgs(raw: string): ParsedPlanArgs {
  const tokens = raw.trim().match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
  let n: number | undefined;
  const task: string[] = [];
  let options = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (options && token === "--") {
      options = false;
    } else if (options && token === "--n") {
      const value = tokens[++index];
      if (!value || !/^\d+$/.test(value)) throw new Error("--n needs an integer from 1 to 5");
      n = Number(value);
    } else if (options && token.startsWith("--n=")) {
      const value = token.slice(4);
      if (!/^\d+$/.test(value)) throw new Error("--n needs an integer from 1 to 5");
      n = Number(value);
    } else if (options && token.startsWith("--")) {
      throw new Error(`Unknown /plan option: ${token}`);
    } else {
      task.push(token.replace(/^("|')|("|')$/g, ""));
    }
  }
  if (n !== undefined && (n < 1 || n > 5)) throw new Error("--n must be between 1 and 5");
  return { n, task: task.join(" ").trim() };
}

export function underlyingModelId(model: string): string {
  return model.split("/").at(-1) ?? model;
}

export function localVerifierLaunch(
  verifierUrl: string,
  configuredAgentDir: string,
  plannerModel: string,
): { projectDir: string; host: string; port: number; model: string } | undefined {
  let url: URL;
  try {
    url = new URL(verifierUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return {
    projectDir: path.resolve(configuredAgentDir, "..", "scripts", "verifier"),
    host: url.hostname,
    port,
    model: underlyingModelId(plannerModel),
  };
}

export function executionMessage(plan: string): string {
  return `Execute the human-selected plan below. Re-check repository evidence as you work and verify the final behavior.\n\n${plan}`;
}

export function boundedText(value: unknown, limit = 20_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}
