export const PLAN_READY_MARKER = "<!-- pi-plan-ready -->";

const SIMPLE_READ_COMMANDS = new Set([
  "basename",
  "cat",
  "cut",
  "dirname",
  "du",
  "echo",
  "fd",
  "file",
  "find",
  "grep",
  "head",
  "jq",
  "ls",
  "printf",
  "pwd",
  "realpath",
  "rg",
  "sort",
  "stat",
  "tail",
  "test",
  "true",
  "tr",
  "tree",
  "type",
  "uniq",
  "wc",
  "which",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["describe", "diff", "grep", "log", "ls-files", "rev-parse", "show", "status"]);
const SAFE_NPM_SUBCOMMANDS = new Set(["explain", "info", "list", "ls", "outdated", "view", "why"]);

function shellSegments(command: string): string[] | undefined {
  if (/[>`\u0000]|`|\$\(|\$\{|\r/.test(command)) return undefined;
  if (/\b(for|while|until|case|function|select)\b/.test(command)) return undefined;
  if (/(^|[^&])&([^&]|$)/.test(command)) return undefined;
  return command
    .split(/\n|;|&&|\|\||\|(?!=)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Conservatively accepts inspection commands; anything ambiguous is blocked. */
export function isReadOnlyBash(command: string): boolean {
  const segments = shellSegments(command);
  if (!segments?.length) return false;

  return segments.every((segment) => {
    const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const executable = words[0]?.replace(/^['"]|['"]$/g, "");
    if (!executable || executable.includes("=") || executable === "[") return false;

    if (SIMPLE_READ_COMMANDS.has(executable)) {
      if (executable === "fd") return !/(^|\s)(-x|--exec|--exec-batch)(=|\s|$)/.test(segment);
      if (executable === "rg" && /(^|\s)--pre(?:-glob)?(=|\s|$)/.test(segment)) return false;
      if (executable === "find" && /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(\s|$)/.test(segment)) return false;
      return true;
    }

    if (executable === "git") {
      const subcommand = words[1]?.replace(/^['"]|['"]$/g, "");
      return Boolean(subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand) && !/(^|\s)--output(?:=|\s)/.test(segment));
    }

    if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
      const subcommand = words[1]?.replace(/^['"]|['"]$/g, "");
      return Boolean(subcommand && SAFE_NPM_SUBCOMMANDS.has(subcommand));
    }

    return false;
  });
}

export function extractCompletedPlan(text: string): string | undefined {
  if (!text.includes(PLAN_READY_MARKER)) return undefined;
  const plan = text.replaceAll(PLAN_READY_MARKER, "").trim();
  return plan || undefined;
}
