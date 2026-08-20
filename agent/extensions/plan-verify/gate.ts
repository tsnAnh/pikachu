import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface PlanReference {
  paths: string[];
  symbols: Array<{ path: string; name: string }>;
  commands: string[];
}

export interface PlanCandidate {
  stance: string;
  plan: string;
  references: PlanReference;
}

interface LensEngine {
  moduleReport(file: string, cwd: string, options?: Record<string, unknown>): Promise<unknown>;
  readSymbol(
    file: string,
    symbol: string,
    cwd: string,
    options?: Record<string, unknown>,
  ): Promise<{ found?: boolean }>;
}

export type LensLoader = () => Promise<LensEngine>;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function packageScript(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (!["npm", "pnpm", "yarn", "bun"].includes(words[0])) return undefined;
  if (words[1] === "run") return words[2];
  if (words[1] && !words[1].startsWith("-")) return words[1];
  return undefined;
}

function commandReason(command: string, cwd: string): string | undefined {
  const script = packageScript(command);
  if (script) {
    const manifest = path.join(cwd, "package.json");
    if (!existsSync(manifest)) return `command references ${script}, but package.json does not exist`;
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    if (!(script in scripts)) return `package script does not exist: ${script}`;
  }
  const make = command.trim().match(/^make\s+([\w.:-]+)/);
  if (make) {
    const file = ["Makefile", "makefile"].map((name) => path.join(cwd, name)).find(existsSync);
    if (!file || !new RegExp(`^${make[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(readFileSync(file, "utf8"))) {
      return `make target does not exist: ${make[1]}`;
    }
  }
  return undefined;
}

const loadLens: LensLoader = async () => import("pi-lens/dist/clients/lens-engine.js");

export async function gateCandidate(
  candidate: PlanCandidate,
  cwd: string,
  symbolCheck: boolean,
  lensLoader: LensLoader = loadLens,
): Promise<{ candidate: PlanCandidate; reasons: string[]; warnings: string[] }> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const root = realpathSync(cwd);
  const verified = new Map<string, string>();
  for (const reference of new Set([
    ...candidate.references.paths,
    ...candidate.references.symbols.map((symbol) => symbol.path),
  ])) {
    const resolved = path.resolve(root, reference);
    if (!inside(root, resolved)) {
      reasons.push(`path escapes repository: ${reference}`);
      continue;
    }
    if (!existsSync(resolved)) {
      reasons.push(`path does not exist: ${reference}`);
      continue;
    }
    const real = realpathSync(resolved);
    if (!inside(root, real)) {
      reasons.push(`path resolves outside repository: ${reference}`);
      continue;
    }
    verified.set(reference, real);
  }
  if (symbolCheck && candidate.references.symbols.length > 0 && reasons.length === 0) {
    try {
      const lens = await lensLoader();
      for (const file of new Set(candidate.references.symbols.map((symbol) => symbol.path))) {
        await lens.moduleReport(file, root, { maxRefsPerSymbol: 1 });
      }
      for (const symbol of candidate.references.symbols) {
        if (!verified.has(symbol.path)) continue;
        const result = await lens.readSymbol(symbol.path, symbol.name, root, {});
        if (!result?.found) reasons.push(`symbol does not exist: ${symbol.path}#${symbol.name}`);
      }
    } catch (error) {
      warnings.push(`pi-lens unavailable; symbol checks skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const command of candidate.references.commands) {
    const reason = commandReason(command, root);
    if (reason) reasons.push(reason);
  }
  return { candidate, reasons, warnings };
}
