import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";

export interface JevActionCandidate {
  id: string;
  description: string;
}

export interface JevChoiceRequest {
  goal: string;
  observation: string;
  captureId?: string;
  history?: string[];
  candidates: JevActionCandidate[];
}

export interface JevChoiceResult {
  selectedId: string;
  confidence: number;
  probabilities: Record<string, number>;
  model?: string;
  abstained: boolean;
}

const MAX_CANDIDATES = 32;
const MIN_CONFIDENCE = 0.65;
const CANDIDATE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export function validateChoiceRequest(request: JevChoiceRequest): Record<string, string> {
  if (!request.goal.trim() || request.goal.length > 1000) throw new Error("goal must contain 1–1000 characters");
  if (!request.observation.trim() || request.observation.length > 5000 || /data:image\//i.test(request.observation)) {
    throw new Error("observation must be compact text without screenshot bytes");
  }
  if (request.captureId !== undefined && (!request.captureId.trim() || request.captureId.length > 128)) {
    throw new Error("captureId must contain 1–128 characters");
  }
  if (request.history && (request.history.length > 6 || request.history.some((item) => item.length > 500))) {
    throw new Error("history must contain at most six short entries");
  }
  if (request.candidates.length < 2 || request.candidates.length > MAX_CANDIDATES) {
    throw new Error(`candidates must contain 2–${MAX_CANDIDATES} entries`);
  }
  const criteria: Record<string, string> = Object.create(null);
  for (const candidate of request.candidates) {
    if (!CANDIDATE_ID.test(candidate.id) || Object.hasOwn(criteria, candidate.id)) {
      throw new Error("candidate IDs must be unique, lowercase, and bounded");
    }
    if (!candidate.description.trim() || candidate.description.length > 240) {
      throw new Error("candidate descriptions must contain 1–240 characters");
    }
    criteria[candidate.id] = candidate.description;
  }
  if (!Object.hasOwn(criteria, "reobserve") || !Object.hasOwn(criteria, "abstain")) {
    throw new Error("candidates must include reobserve and abstain");
  }
  return criteria;
}

export async function chooseBoundedAction(
  client: Pick<TypeSafeClient, "systemOne">,
  request: JevChoiceRequest,
  signal?: AbortSignal,
): Promise<JevChoiceResult> {
  const criteria = validateChoiceRequest(request);
  const response = await client.systemOne(
    {
      state: {
        goal: request.goal,
        capture_id: request.captureId ?? null,
        observation: request.observation,
        history: request.history ?? [],
      },
      questions: {
        driver_action: choice("Which candidate should the caller consider next?", criteria),
      },
    },
    { signal, timeout: 15_000, retry: { maxRetries: 0 } },
  );
  const answer = response.answers.driver_action;
  if (answer?.type !== "choice" || !Object.hasOwn(criteria, answer.choice)) {
    throw new Error("Jev returned an unknown candidate");
  }
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error("Jev returned invalid confidence");
  }
  const probabilities: Record<string, number> = Object.create(null);
  for (const [id, probability] of Object.entries(answer.probabilities)) {
    if (!Object.hasOwn(criteria, id) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("Jev returned invalid probabilities");
    }
    probabilities[id] = probability;
  }
  const abstained = answer.confidence < MIN_CONFIDENCE;
  return {
    selectedId: abstained ? "abstain" : answer.choice,
    confidence: answer.confidence,
    probabilities,
    ...(typeof response.model === "string" && response.model.trim() ? { model: response.model } : {}),
    abstained,
  };
}
