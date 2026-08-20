import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "../npm/node_modules/pi-subagents/src/api/delegation.ts";
import { registerSubagentCapabilityCeiling } from "../npm/node_modules/pi-subagents/src/api/capability-ceiling.ts";
import {
  boundedText,
  executionMessage,
  localVerifierLaunch,
  parsePlanArgs,
  suggestFanout,
  underlyingModelId,
} from "./plan-verify/core.ts";
import { gateCandidate, type PlanCandidate } from "./plan-verify/gate.ts";

const ENTRY_TYPE = "plan-verify-result";
const SELECTION_TYPE = "plan-verify-selection";
const PROGRESS_TYPE = "plan-verify-progress";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "module_report", "read_symbol"];

interface PlanVerifySettings {
  n: number;
  stances: string[];
  plannerModel: string;
  verifierUrl: string;
  criteria: string;
  pivots: number;
  nEvaluations: number;
  gate: { symbolCheck: boolean; groundednessFloor: number };
}

interface CandidateResult extends PlanCandidate {
  groundedness?: number;
  rankScore?: number;
  criterionScores?: Record<string, number>;
}

interface DroppedPlan {
  stance: string;
  plan: string;
  reasons: string[];
}

interface PlanEntryData {
  title: string;
  lines: string[];
  expanded?: string[];
}

interface SelectionState {
  sessionId: string;
  plan: string;
  stepIndex: number;
  declineWarned: boolean;
}

interface PlanVerifierControls {
  setPlanMode(on: boolean, ctx: ExtensionContext): void;
  isPlanMode(): boolean;
}

const DEFAULTS: PlanVerifySettings = {
  n: 5,
  stances: ["minimal", "test-first", "refactor-first", "spike", "do-nothing"],
  plannerModel: "openai-codex/gpt-5.6-sol",
  verifierUrl: "http://127.0.0.1:8899",
  criteria: "criteria/plan/v1.md",
  pivots: 2,
  nEvaluations: 4,
  gate: { symbolCheck: true, groundednessFloor: 0.4 },
};

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    plan: { type: "string", minLength: 1 },
    references: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        symbols: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, name: { type: "string" } },
            required: ["path", "name"],
            additionalProperties: false,
          },
        },
        commands: { type: "array", items: { type: "string" } },
      },
      required: ["paths", "symbols", "commands"],
      additionalProperties: false,
    },
  },
  required: ["plan", "references"],
  additionalProperties: false,
} as const;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

function loadSettings(): PlanVerifySettings {
  const raw = JSON.parse(readFileSync(path.join(agentDir(), "settings.json"), "utf8"));
  const configured = raw.planVerify ?? {};
  const settings: PlanVerifySettings = {
    ...DEFAULTS,
    ...configured,
    gate: { ...DEFAULTS.gate, ...(configured.gate ?? {}) },
  };
  if (!Array.isArray(settings.stances) || settings.stances.length === 0 || settings.stances.length > 5) {
    throw new Error("planVerify.stances must contain between one and five distinct stances");
  }
  if (new Set(settings.stances).size !== settings.stances.length) {
    throw new Error("planVerify.stances must be distinct");
  }
  if (typeof settings.plannerModel !== "string" || !settings.plannerModel.includes("/")) {
    throw new Error("planVerify.plannerModel must be a provider/model string");
  }
  if (!/^https?:\/\//.test(settings.verifierUrl)) {
    throw new Error("planVerify.verifierUrl must be an HTTP(S) URL");
  }
  if (!Number.isInteger(settings.pivots) || settings.pivots < 1 || settings.pivots > 5) {
    throw new Error("planVerify.pivots must be an integer from 1 to 5");
  }
  if (!Number.isInteger(settings.nEvaluations) || settings.nEvaluations < 1 || settings.nEvaluations > 16) {
    throw new Error("planVerify.nEvaluations must be an integer from 1 to 16");
  }
  if (
    typeof settings.gate.groundednessFloor !== "number" ||
    settings.gate.groundednessFloor < 0 ||
    settings.gate.groundednessFloor > 1
  ) {
    throw new Error("planVerify.gate.groundednessFloor must be between 0 and 1");
  }
  return settings;
}

function append(pi: ExtensionAPI, title: string, lines: string[], expanded?: string[]): void {
  pi.appendEntry<PlanEntryData>(ENTRY_TYPE, { title, lines, expanded });
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(300_000) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const detail = body?.detail ?? body?.error ?? `${response.status} ${response.statusText}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

function post<T>(base: string, route: string, body: unknown): Promise<T> {
  return requestJson<T>(`${base.replace(/\/$/, "")}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function isCandidate(value: unknown): value is Omit<PlanCandidate, "stance"> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const references = candidate.references as Record<string, unknown> | undefined;
  return (
    typeof candidate.plan === "string" &&
    !!references &&
    Array.isArray(references.paths) &&
    references.paths.every((item) => typeof item === "string") &&
    Array.isArray(references.symbols) &&
    references.symbols.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).path === "string" &&
        typeof (item as Record<string, unknown>).name === "string",
    ) &&
    Array.isArray(references.commands) &&
    references.commands.every((item) => typeof item === "string")
  );
}

function delegate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stance: string,
  model: string,
  task: string,
  ownerRunId: string,
): Promise<PlanCandidate> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const nodeId = `plan-${stance}`;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${stance} planner timed out`));
    }, 10 * 60_000);
    const unsubscribe = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
      const response = payload as SubagentDelegationResponse;
      if (response.requestId !== requestId || response.ownerRunId !== ownerRunId || response.nodeId !== nodeId) return;
      clearTimeout(timer);
      unsubscribe();
      if (response.status !== "completed" || response.result?.kind !== "structured") {
        reject(new Error(response.error || `${stance} planner ended with ${response.status}`));
        return;
      }
      if (!isCandidate(response.result.value)) {
        reject(new Error(`${stance} planner returned invalid structured output`));
        return;
      }
      resolve({ stance, ...response.result.value });
    });
    const request: SubagentDelegationRequest = {
      requestId,
      ownerRunId,
      nodeId,
      agent: `plan-${stance}`,
      task:
        `Plan this task from your assigned stance:\n\n${task}\n\n` +
        "Inspect the repository read-only. Return the decision-complete plan and only references the plan materially relies on.",
      context: "fresh",
      cwd: ctx.cwd,
      model,
      thinking: "high",
      timeoutMs: 10 * 60_000,
      turnBudget: { maxTurns: 16, graceTurns: 2 },
      toolBudget: { hard: 40 },
      artifacts: false,
      result: { kind: "structured", schema: RESULT_SCHEMA },
    };
    pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
  });
}

function criteriaPath(settings: PlanVerifySettings): string {
  return path.resolve(agentDir(), settings.criteria);
}

function verifierBody(settings: PlanVerifySettings): Record<string, unknown> {
  return {
    criteria_path: criteriaPath(settings),
    criteria_version: "plan/v1",
    n_evaluations: settings.nEvaluations,
  };
}

function planLines(
  candidates: CandidateResult[],
  dropped: DroppedPlan[],
  degraded?: string,
  disagreement?: Record<string, { a: number; b: number }>,
): { lines: string[]; expanded: string[] } {
  const lines = degraded
    ? [`Degraded — ${degraded}`, `${candidates.length} gate-passing plan(s), unranked.`]
    : candidates.map(
        (candidate, index) =>
          `${index + 1}. ${candidate.stance} — rank ${candidate.rankScore?.toFixed(3) ?? "n/a"}, groundedness ${candidate.groundedness?.toFixed(3) ?? "n/a"}`,
      );
  for (const item of dropped) lines.push(`Dropped ${item.stance} — ${item.reasons.join("; ")}`);
  const expanded: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    expanded.push(`\nPLAN ${index + 1} — ${candidate.stance}\n${candidate.plan}`);
    if (candidate.criterionScores) {
      expanded.push(
        `Criteria: ${Object.entries(candidate.criterionScores)
          .map(([name, score]) => `${name}=${score.toFixed(3)}`)
          .join(", ")}`,
      );
    }
  }
  for (const item of dropped) expanded.push(`\nDROPPED — ${item.stance}\n${item.reasons.join("; ")}\n${item.plan}`);
  if (disagreement) {
    const [largest] = Object.entries(disagreement).sort(
      (left, right) => Math.abs(right[1].a - right[1].b) - Math.abs(left[1].a - left[1].b),
    );
    if (largest) {
      const [criterion, scores] = largest;
      const favored = scores.a === scores.b ? "neither plan" : scores.a > scores.b ? "the first plan" : "the second plan";
      lines.push(
        `Top-two disagreement: ${criterion} favors ${favored} by ${Math.abs(scores.a - scores.b).toFixed(3)}.`,
      );
    }
    expanded.push(
      `\nTOP-TWO DISAGREEMENT\n${Object.entries(disagreement)
        .map(([criterion, scores]) => `${criterion}: first=${scores.a.toFixed(3)}, second=${scores.b.toFixed(3)}`)
        .join("\n")}`,
    );
  }
  return { lines, expanded };
}

function restoreSelection(ctx: ExtensionContext): SelectionState | undefined {
  const branch = ctx.sessionManager.getBranch();
  let selectionIndex = -1;
  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === SELECTION_TYPE) selectionIndex = index;
  }
  const latest = selectionIndex >= 0 ? branch[selectionIndex] : undefined;
  if (!latest || latest.type !== "custom") return undefined;
  const data = latest.data as { plan?: unknown } | undefined;
  if (typeof data?.plan !== "string") return undefined;
  const progress = branch
    .slice(selectionIndex + 1)
    .filter((entry) => entry.type === "custom" && entry.customType === PROGRESS_TYPE).length;
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    plan: data.plan,
    stepIndex: progress,
    declineWarned: false,
  };
}

function turnText(event: TurnEndEvent): string {
  return boundedText(
    {
      assistant: event.message,
      observedToolResults: event.toolResults,
    },
    40_000,
  );
}

export function installPlanVerifier(pi: ExtensionAPI, controls: PlanVerifierControls) {
  let pendingN: number | undefined;
  let running = false;
  let selection: SelectionState | undefined;
  let trackingQueue: Promise<void> = Promise.resolve();
  let verifierStarted = false;

  async function ensureVerifier(settings: PlanVerifySettings, ctx: ExtensionContext): Promise<void> {
    const launch = localVerifierLaunch(settings.verifierUrl, agentDir(), settings.plannerModel);
    if (!launch || verifierStarted) return;
    try {
      const response = await fetch(`${settings.verifierUrl.replace(/\/$/, "")}/healthz`, {
        signal: AbortSignal.timeout(1_500),
      });
      await response.body?.cancel();
      return;
    } catch {
      // No listener: launch the bundled local service below.
    }
    if (!existsSync(path.join(launch.projectDir, "pyproject.toml"))) {
      ctx.ui.notify("Plan verifier could not start because its bundled service is missing.", "warning");
      return;
    }
    verifierStarted = true;
    const child = spawn(
      "uv",
      [
        "run",
        "--frozen",
        "--project",
        launch.projectDir,
        "uvicorn",
        "service:app",
        "--app-dir",
        launch.projectDir,
        "--host",
        launch.host,
        "--port",
        String(launch.port),
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, LLM_VERIFIER_MODEL: launch.model },
      },
    );
    child.once("error", () => {
      verifierStarted = false;
      ctx.ui.notify("Plan verifier could not start; planning will remain available without ranking.", "warning");
    });
    child.unref();
  }

  pi.registerEntryRenderer<PlanEntryData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data ?? { title: "Verified planning", lines: [] };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const body = [theme.fg("accent", data.title), ...data.lines];
    if (expanded && data.expanded) body.push(...data.expanded);
    box.addChild(new Text(body.join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer<{ score: number; trend: string; stepIndex: number }>(
    PROGRESS_TYPE,
    (entry, _options, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      return new Text(
        theme.fg("dim", `Plan progress step ${data.stepIndex}: ${data.score.toFixed(3)} (${data.trend})`),
        1,
        0,
      );
    },
  );

  async function choose(
    ctx: ExtensionCommandContext | ExtensionContext,
    candidates: CandidateResult[],
    settings: PlanVerifySettings,
  ): Promise<void> {
    if (ctx.mode !== "tui") return;
    const labels = candidates.map(
      (candidate, index) => `${index + 1}. ${candidate.stance}\n${candidate.plan}`,
    );
    const selected = await ctx.ui.select("Choose a plan to execute (Esc leaves all unselected)", labels);
    const index = selected ? labels.indexOf(selected) : -1;
    if (index < 0) return;
    const plan = candidates[index].plan;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      await requestJson(`${settings.verifierUrl.replace(/\/$/, "")}/v1/track/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    } catch {
      // Tracking is best-effort; selection and execution must remain usable.
    }
    selection = { sessionId, plan, stepIndex: 0, declineWarned: false };
    pi.appendEntry(SELECTION_TYPE, { plan });
    controls.setPlanMode(false, ctx);
    pi.sendMessage(
      { customType: "plan-execution", content: executionMessage(plan), display: true },
      { triggerTurn: true },
    );
  }

  async function run(task: string, explicitN: number | undefined, ctx: ExtensionCommandContext | ExtensionContext) {
    if (running) throw new Error("A verified planning run is already active");
    running = true;
    try {
      const settings = loadSettings();
      await ensureVerifier(settings, ctx);
      const suggestion = suggestFanout(task);
      const effectiveN = explicitN ?? suggestion.n;
      if (effectiveN > settings.stances.length) {
        throw new Error(`--n ${effectiveN} exceeds the ${settings.stances.length} configured distinct stances`);
      }
      const summary = [`Suggested fan-out: ${suggestion.n} — ${suggestion.reason}.`];
      if (explicitN !== undefined) summary.push(`Using ${effectiveN} from --n.`);
      else summary.push(`Using suggested fan-out ${effectiveN}.`);
      append(pi, "Verified planning", summary);

      const systemPrompt = ctx.getSystemPrompt().toLowerCase();
      if (systemPrompt.includes("caveman")) ctx.ui.notify("Caveman appears active; compressed plan prose may reduce verifier accuracy.", "warning");
      if (systemPrompt.includes("observational memory")) {
        ctx.ui.notify("Observational memory appears active; only fresh subagent evidence is used for candidate plans.", "warning");
      }

      const stances = settings.stances.slice(0, effectiveN);
      const ceiling = registerSubagentCapabilityCeiling({
        sessionId: ctx.sessionManager.getSessionId(),
        source: "plan-verify",
        ceiling: { allowedAgents: stances.map((stance) => `plan-${stance}`), allowedTools: READ_ONLY_TOOLS },
      });
      const ownerRunId = `plan-verify-${randomUUID()}`;
      const settled = await Promise.allSettled(
        stances.map((stance) => delegate(pi, ctx, stance, settings.plannerModel, task, ownerRunId)),
      ).finally(() => ceiling.dispose());
      const generated: PlanCandidate[] = [];
      const dropped: DroppedPlan[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") generated.push(result.value);
        else dropped.push({ stance: stances[index], plan: "No plan returned.", reasons: [String(result.reason)] });
      });

      const gated = await Promise.all(
        generated.map((candidate) => gateCandidate(candidate, ctx.cwd, settings.gate.symbolCheck)),
      );
      const gateWarnings = new Set<string>();
      const survivors: CandidateResult[] = [];
      for (const result of gated) {
        result.warnings.forEach((warning) => gateWarnings.add(warning));
        if (result.reasons.length) dropped.push({ ...result.candidate, reasons: result.reasons });
        else survivors.push(result.candidate);
      }
      if (survivors.length === 0) {
        const rendered = planLines([], dropped, "no candidate passed repository validation");
        append(pi, "Verified planning stopped", rendered.lines, rendered.expanded);
        return;
      }

      let degraded: string | undefined;
      let ranked = survivors;
      let disagreement: Record<string, { a: number; b: number }> | undefined;
      try {
        const health = await requestJson<{ model: string; logprobs: boolean }>(`${settings.verifierUrl.replace(/\/$/, "")}/healthz`);
        if (!health.logprobs) throw new Error("verifier health probe did not confirm logprobs");
        if (underlyingModelId(settings.plannerModel) !== health.model) {
          throw new Error(`planner model ${underlyingModelId(settings.plannerModel)} does not match verifier model ${health.model}`);
        }
        const scores = await Promise.all(
          survivors.map((candidate) =>
            post<{ score: number }>(settings.verifierUrl, "/v1/score", {
              ...verifierBody(settings),
              problem: task,
              candidate: candidate.plan,
            }),
          ),
        );
        scores.forEach((score, index) => {
          survivors[index].groundedness = score.score;
        });
        const belowFloor = survivors.filter(
          (candidate) => (candidate.groundedness ?? 0) < settings.gate.groundednessFloor,
        );
        const verifierDropped = belowFloor.map((candidate) =>
          ({
            ...candidate,
            reasons: [`groundedness ${candidate.groundedness?.toFixed(3)} is below ${settings.gate.groundednessFloor}`],
          }),
        );
        ranked = survivors.filter((candidate) => !belowFloor.includes(candidate));
        if (ranked.length === 0) {
          dropped.push(...verifierDropped);
          const rendered = planLines([], dropped, "all candidates failed groundedness");
          append(pi, "Verified planning stopped", rendered.lines, rendered.expanded);
          return;
        }
        if (ranked.length === 1) {
          ranked[0].rankScore = ranked[0].groundedness;
        } else if (ranked.length === 2) {
          const comparison = await post<{
            a: number;
            b: number;
            perCriterion: Record<string, { a: number; b: number }>;
            winner: number;
          }>(settings.verifierUrl, "/v1/compare", {
            ...verifierBody(settings),
            problem: task,
            candidate_a: ranked[0].plan,
            candidate_b: ranked[1].plan,
          });
          ranked[0].rankScore = comparison.a;
          ranked[1].rankScore = comparison.b;
          for (const [criterion, values] of Object.entries(comparison.perCriterion)) {
            (ranked[0].criterionScores ??= {})[criterion] = values.a;
            (ranked[1].criterionScores ??= {})[criterion] = values.b;
          }
          disagreement = comparison.perCriterion;
          if (comparison.winner === 1) ranked = [ranked[1], ranked[0]];
        } else {
          const selectionResult = await post<{
            ranking: number[];
            scores: number[];
            perCriterion: Record<string, number[]>;
          }>(settings.verifierUrl, "/v1/select", {
            ...verifierBody(settings),
            problem: task,
            candidates: ranked.map((candidate) => candidate.plan),
            session_id: ctx.sessionManager.getSessionId(),
            pivots: settings.pivots,
            seed: 0,
          });
          ranked.forEach((candidate, index) => {
            candidate.rankScore = selectionResult.scores[index];
            candidate.criterionScores = Object.fromEntries(
              Object.entries(selectionResult.perCriterion).map(([criterion, values]) => [criterion, values[index]]),
            );
          });
          ranked = selectionResult.ranking.map((index) => ranked[index]);
          const comparison = await post<{
            perCriterion: Record<string, { a: number; b: number }>;
          }>(settings.verifierUrl, "/v1/compare", {
            ...verifierBody(settings),
            problem: task,
            candidate_a: ranked[0].plan,
            candidate_b: ranked[1].plan,
          });
          disagreement = comparison.perCriterion;
        }
        dropped.push(...verifierDropped);
      } catch (error) {
        degraded = error instanceof Error ? error.message : String(error);
        ranked = survivors.map((candidate) => ({
          ...candidate,
          groundedness: undefined,
          rankScore: undefined,
          criterionScores: undefined,
        }));
      }

      const rendered = planLines(ranked, dropped, degraded, disagreement);
      if (gateWarnings.size) rendered.lines.push(...[...gateWarnings]);
      append(pi, degraded ? "Planning results — degraded" : "Verified planning ranking", rendered.lines, rendered.expanded);
      await choose(ctx, ranked, settings);
    } finally {
      running = false;
    }
  }

  pi.on("input", async (event, ctx) => {
    if (pendingN === undefined && !controls.isPlanMode()) return;
    if (pendingN === undefined || event.source === "extension" || event.text.startsWith("/")) return;
    const n = pendingN;
    pendingN = undefined;
    if (event.images?.length) {
      ctx.ui.notify("Verified planning is text-only; remove the attached images and submit the task again.", "warning");
      pendingN = n;
      return { action: "handled" };
    }
    try {
      await run(event.text, n === 0 ? undefined : n, ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!selection || selection.sessionId !== ctx.sessionManager.getSessionId() || controls.isPlanMode()) return;
    const current = selection;
    const text = turnText(event);
    trackingQueue = trackingQueue.then(async () => {
      try {
        const settings = loadSettings();
        const nextStep = current.stepIndex + 1;
        const result = await post<{ score: number; trend: string; stepIndex: number }>(
          settings.verifierUrl,
          `/v1/track/${encodeURIComponent(current.sessionId)}/step`,
          {
            step_index: nextStep,
            text,
            ...(nextStep === 1 ? { problem: current.plan } : {}),
            n_evaluations: settings.nEvaluations,
          },
        );
        current.stepIndex = result.stepIndex;
        pi.appendEntry(PROGRESS_TYPE, result);
        if (result.trend === "declining" && !current.declineWarned) {
          current.declineWarned = true;
          pi.sendMessage(
            {
              customType: "plan-progress-correction",
              content: "Re-check the human-selected plan against the repository evidence and correct the execution path before continuing.",
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } else if (result.trend !== "declining") {
          current.declineWarned = false;
        }
        if (result.stepIndex >= 2 && result.score < 0.25) {
          ctx.ui.notify("Execution appears far from satisfying the selected plan. Human review is recommended.", "warning");
        }
      } catch (error) {
        append(pi, "Plan progress unavailable", [error instanceof Error ? error.message : String(error)]);
      }
    });
    await trackingQueue;
  });

  pi.on("session_start", async (_event, ctx) => {
    selection = restoreSelection(ctx);
    void ensureVerifier(loadSettings(), ctx).catch((error) => {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    });
  });

  pi.registerCommand("plan-review", {
    description: "Score a completed tracked plan session without changing model context",
    handler: async (args, ctx) => {
      const session = args.trim() || ctx.sessionManager.getSessionId();
      try {
        const settings = loadSettings();
        const result = await post<{ steps: number[]; scores: number[]; final: number }>(
          settings.verifierUrl,
          "/v1/track/offline",
          { session, n_evaluations: settings.nEvaluations },
        );
        append(
          pi,
          `Offline plan review — ${session}`,
          [`Final progress: ${result.final.toFixed(3)}`],
          result.steps.map((step, index) => `Step ${step}: ${result.scores[index].toFixed(3)}`),
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  return {
    async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parsed = parsePlanArgs(args);
      if (parsed.task) {
        await run(parsed.task, parsed.n, ctx);
        return;
      }
      pendingN = parsed.n ?? 0;
      ctx.ui.notify("Plan mode on — submit the task to plan next.", "info");
    },
    cancelPending(): void {
      pendingN = undefined;
    },
  };
}

// Pi auto-discovers every top-level extension file. plan-mode.ts imports and installs
// this module so it can keep sole ownership of the /plan command and read-only gate.
export default function planVerifyHelper(): void {}
