from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import tempfile
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import llm_verifier
from fastapi import FastAPI, HTTPException, Response, status
from llm_verifier import ProgressTracker, compare, select, track
from llm_verifier import pivot_tournament as ppt
from llm_verifier.fine_grained_reward import (
    SCALE,
    _find_tag_logprobs,
    build_prompt,
    call_verifier,
    create_client,
    directed_reward,
)
from llm_verifier.prompts import load_prompts
from pydantic import BaseModel, Field

from store import Store


NORMALIZER_VERSION = "1"
NULL_PLAN = "Do not implement this task. Make no repository changes and propose no execution steps."
DEFAULT_CRITERIA = Path(__file__).parents[2] / "agent" / "criteria" / "plan" / "v1.md"
REPO_ROOT = Path(os.environ.get("PLAN_VERIFY_ROOT", Path(__file__).parents[2])).resolve()
store = Store()
trackers: dict[str, ProgressTracker] = {}
tracker_lock = threading.RLock()
health_state: dict[str, Any] = {"ok": False, "error": "capability probe has not run"}


class CriteriaRequest(BaseModel):
    criteria_path: str | None = None
    criteria_version: str = "plan/v1"
    n_evaluations: int = Field(default=4, ge=1, le=16)


class ScoreRequest(CriteriaRequest):
    problem: str = Field(min_length=1, max_length=1_000_000)
    candidate: str = Field(min_length=1, max_length=1_000_000)


class CompareRequest(CriteriaRequest):
    problem: str = Field(min_length=1, max_length=1_000_000)
    candidate_a: str = Field(min_length=1, max_length=1_000_000)
    candidate_b: str = Field(min_length=1, max_length=1_000_000)


class SelectRequest(CriteriaRequest):
    problem: str = Field(min_length=1, max_length=1_000_000)
    candidates: list[str] = Field(min_length=1, max_length=5)
    session_id: str | None = Field(default=None, max_length=200)
    pivots: int = Field(default=2, ge=1, le=5)
    seed: int = 0


class TrackStepRequest(BaseModel):
    step_index: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=200_000)
    problem: str | None = Field(default=None, max_length=1_000_000)
    n_evaluations: int = Field(default=4, ge=1, le=16)


class OfflineTrackRequest(BaseModel):
    session: str = Field(min_length=1, max_length=200)
    n_evaluations: int = Field(default=4, ge=1, le=16)


def verifier_model() -> str:
    return os.environ.get("LLM_VERIFIER_MODEL", "gpt-5.6-sol")


def _criteria_path(raw: str | None) -> Path:
    path = Path(raw).expanduser() if raw else DEFAULT_CRITERIA
    path = path.resolve()
    try:
        path.relative_to(REPO_ROOT)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "criteria path must stay inside PLAN_VERIFY_ROOT") from exc
    if not path.is_file():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"criteria file not found: {path}")
    return path


def _criteria(raw: str | None) -> tuple[Path, str, list[dict[str, str]]]:
    path = _criteria_path(raw)
    note, criteria = load_prompts(str(path))
    return path, note, criteria


def _normalize(value: Any) -> Any:
    if isinstance(value, str):
        return "\n".join(line.rstrip() for line in value.replace("\r\n", "\n").split("\n")).strip()
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in sorted(value.items())}
    return value


def _cache_key(kind: str, payload: dict[str, Any], path: Path, version: str) -> str:
    canonical = {
        "kind": kind,
        "payload": _normalize(payload),
        "criteriaVersion": version,
        "criteriaSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "model": verifier_model(),
        "normalizerVersion": NORMALIZER_VERSION,
        "llmVerifierVersion": llm_verifier.__version__,
    }
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _probe() -> dict[str, Any]:
    model = verifier_model()
    criterion = {
        "id": "probe",
        "name": "Capability probe",
        "description": "Prefer the trajectory that explicitly verifies the requested behavior.",
    }
    prompt = build_prompt(
        "Choose the better verified plan.",
        "Inspect the target and run the relevant check.",
        "Declare success without inspection.",
        criterion,
        "Trust observed evidence.",
    )
    client = create_client()
    _text, tokens, logprobs = call_verifier(client, prompt, model=model)
    valid = SCALE["valid_tokens"]
    coverage: dict[str, int] = {}
    for tag in ("<score_A>", "<score_B>"):
        alternatives = _find_tag_logprobs(tokens, logprobs, tag) or []
        letters = {
            token.strip().lstrip(">").strip()
            for token, _value in alternatives
            if token.strip().lstrip(">").strip() in valid
        }
        coverage[tag] = len(letters)
        if len(letters) < 2:
            raise RuntimeError(f"{tag} did not expose a score-token logprob distribution")
    return {
        "status": "ok",
        "model": model,
        "logprobs": True,
        "scoreTokenCoverage": coverage,
        "llmVerifierVersion": llm_verifier.__version__,
    }


def run_probe() -> dict[str, Any]:
    global health_state
    try:
        health_state = {"ok": True, **_probe()}
    except Exception as exc:  # health must report refusal/unavailability, not crash startup
        health_state = {
            "ok": False,
            "status": "failed",
            "model": verifier_model(),
            "logprobs": False,
            "error": str(exc),
            "llmVerifierVersion": llm_verifier.__version__,
        }
    return health_state


def _require_healthy() -> None:
    if not health_state.get("ok"):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, health_state)


def _groundedness(criteria: list[dict[str, str]]) -> list[dict[str, str]]:
    selected = [criterion for criterion in criteria if criterion["id"] == "groundedness"]
    if len(selected) != 1:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "criteria must define groundedness")
    return selected


def _score_candidate(req: ScoreRequest, criteria: list[dict[str, str]], note: str) -> dict[str, Any]:
    criterion = _groundedness(criteria)
    model = verifier_model()
    forward = compare(
        req.problem,
        req.candidate,
        NULL_PLAN,
        criteria=criterion,
        ground_truth_note=note,
        n_evaluations=req.n_evaluations,
        model=model,
    )
    reverse = compare(
        req.problem,
        NULL_PLAN,
        req.candidate,
        criteria=criterion,
        ground_truth_note=note,
        n_evaluations=req.n_evaluations,
        model=model,
    )
    value = (forward[0] + reverse[1]) / 2
    return {
        "score": value,
        "criterion": "groundedness",
        "comparisons": [
            {"orientation": "candidate-null", "candidate": forward[0], "baseline": forward[1]},
            {"orientation": "null-candidate", "candidate": reverse[1], "baseline": reverse[0]},
        ],
        "model": model,
    }


def _compare_candidates(req: CompareRequest, criteria: list[dict[str, str]], note: str) -> dict[str, Any]:
    per_criterion: dict[str, dict[str, float]] = {}
    raw: list[dict[str, Any]] = []
    for criterion in criteria:
        one = [criterion]
        forward = compare(
            req.problem,
            req.candidate_a,
            req.candidate_b,
            criteria=one,
            ground_truth_note=note,
            n_evaluations=req.n_evaluations,
            model=verifier_model(),
        )
        reverse = compare(
            req.problem,
            req.candidate_b,
            req.candidate_a,
            criteria=one,
            ground_truth_note=note,
            n_evaluations=req.n_evaluations,
            model=verifier_model(),
        )
        score_a = (forward[0] + reverse[1]) / 2
        score_b = (forward[1] + reverse[0]) / 2
        per_criterion[criterion["id"]] = {"a": score_a, "b": score_b}
        raw.extend(
            [
                {"criterion": criterion["id"], "orientation": "a-b", "scoreA": forward[0], "scoreB": forward[1]},
                {"criterion": criterion["id"], "orientation": "b-a", "scoreA": reverse[1], "scoreB": reverse[0]},
            ]
        )
    aggregate_a = sum(row["a"] for row in per_criterion.values()) / len(per_criterion)
    aggregate_b = sum(row["b"] for row in per_criterion.values()) / len(per_criterion)
    return {
        "a": aggregate_a,
        "b": aggregate_b,
        "winner": 0 if aggregate_a >= aggregate_b else 1,
        "perCriterion": per_criterion,
        "comparisons": raw,
        "model": verifier_model(),
    }


def _raw_rows(cache: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key, value in cache.items():
        criterion, _task, pair, repetition = key.split("|")
        a, b = pair.split(",")
        rows.append(
            {
                "criterion": criterion,
                "a": int(a),
                "b": int(b),
                "rep": int(repetition),
                "scoreA": float(value["score_A"]),
                "scoreB": float(value["score_B"]),
            }
        )
    return sorted(rows, key=lambda row: (row["criterion"], row["a"], row["b"], row["rep"]))


def _cache_dict(rows: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    return {
        f"{row['criterion']}|task|{row['a']},{row['b']}|{row['rep']}": {
            "score_A": row["scoreA"],
            "score_B": row["scoreB"],
        }
        for row in rows
    }


def _rank_from_rows(
    rows: list[dict[str, Any]],
    n: int,
    criteria_ids: list[str],
    n_evaluations: int,
    pivots: int,
    seed: int,
) -> tuple[list[int], list[float], dict[str, list[float]]]:
    scores = _cache_dict(rows)
    ring = ppt.ring_cycle(n, random.Random(seed))

    def reward(ids: list[str]):
        return lambda a, b: directed_reward(scores, "task", a, b, ids, n_evaluations)

    wins, counts = [0.0] * n, [0] * n
    ppt.accumulate(ring, reward(criteria_ids), wins, counts)
    pivot_set = ppt.select_pivots(wins, counts, pivots)
    pivot_pairs = ppt.pivot_round_pairs(n, pivot_set)
    pairs = ring + pivot_pairs
    wins, counts = [0.0] * n, [0] * n
    ppt.accumulate(pairs, reward(criteria_ids), wins, counts)
    aggregate = [wins[i] / counts[i] if counts[i] else 0.0 for i in range(n)]
    ranking = sorted(range(n), key=lambda i: (-aggregate[i], i))
    breakdown: dict[str, list[float]] = {}
    for criterion_id in criteria_ids:
        criterion_wins, criterion_counts = [0.0] * n, [0] * n
        ppt.accumulate(pairs, reward([criterion_id]), criterion_wins, criterion_counts)
        breakdown[criterion_id] = [
            criterion_wins[i] / criterion_counts[i] if criterion_counts[i] else 0.0
            for i in range(n)
        ]
    return ranking, aggregate, breakdown


@asynccontextmanager
async def lifespan(_app: FastAPI):
    run_probe()
    yield


app = FastAPI(title="pi plan verifier", version="1", lifespan=lifespan)


@app.get("/healthz")
def healthz(response: Response) -> dict[str, Any]:
    if not health_state.get("ok"):
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {key: value for key, value in health_state.items() if key != "ok"}


@app.post("/v1/score")
def score_endpoint(req: ScoreRequest) -> dict[str, Any]:
    _require_healthy()
    path, note, criteria = _criteria(req.criteria_path)
    key = _cache_key("score", req.model_dump(), path, req.criteria_version)
    cached = store.get_cached(key)
    if cached:
        return {**cached, "cached": True}
    try:
        result = _score_candidate(req, criteria, note)
    except Exception as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"verifier scoring failed: {exc}") from exc
    store.put_cached(key, "score", result)
    return {**result, "cached": False}


@app.post("/v1/compare")
def compare_endpoint(req: CompareRequest) -> dict[str, Any]:
    _require_healthy()
    path, note, criteria = _criteria(req.criteria_path)
    key = _cache_key("compare", req.model_dump(), path, req.criteria_version)
    cached = store.get_cached(key)
    if cached:
        return {**cached, "cached": True}
    try:
        result = _compare_candidates(req, criteria, note)
    except Exception as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"verifier comparison failed: {exc}") from exc
    store.put_cached(key, "compare", result)
    return {**result, "cached": False}


@app.post("/v1/select")
def select_endpoint(req: SelectRequest) -> dict[str, Any]:
    _require_healthy()
    if any(not candidate.strip() for candidate in req.candidates):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "candidates must not be blank")
    path, _note, criteria = _criteria(req.criteria_path)
    criteria_ids = [criterion["id"] for criterion in criteria]
    key = _cache_key("select", req.model_dump(), path, req.criteria_version)
    persisted = store.load_selection(key)
    if persisted:
        ranking, scores, breakdown = _rank_from_rows(
            persisted["comparisons"],
            len(persisted["candidates"]),
            persisted["criteriaIds"],
            persisted["nEvaluations"],
            persisted["pivots"],
            persisted["seed"],
        )
        return {
            "runId": persisted["runId"],
            "winner": ranking[0],
            "ranking": ranking,
            "scores": scores,
            "perCriterion": breakdown,
            "comparisons": persisted["comparisons"],
            "model": verifier_model(),
            "cached": True,
        }
    if len(req.candidates) < 3:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "use /v1/score for one candidate or /v1/compare for two")
    try:
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as handle:
            cache_path = handle.name
        Path(cache_path).unlink(missing_ok=True)
        result = select(
            req.problem,
            req.candidates,
            criteria=str(path),
            n_evaluations=req.n_evaluations,
            pivots=req.pivots,
            seed=req.seed,
            model=verifier_model(),
            cache=cache_path,
            progress=False,
            on_error="raise",
        )
        cache = json.loads(Path(cache_path).read_text())
        rows = _raw_rows(cache)
        ranking, scores, breakdown = _rank_from_rows(
            rows,
            len(req.candidates),
            criteria_ids,
            req.n_evaluations,
            req.pivots,
            req.seed,
        )
        if ranking != result.ranking:
            raise RuntimeError("persisted comparisons did not reproduce select() ranking")
        if any(abs(left - right) > 1e-12 for left, right in zip(scores, result.scores)):
            raise RuntimeError("persisted comparisons did not reproduce select() scores")
    except Exception as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"verifier selection failed: {exc}") from exc
    finally:
        if "cache_path" in locals():
            Path(cache_path).unlink(missing_ok=True)
    run_id = str(uuid.uuid4())
    response = {
        "runId": run_id,
        "winner": ranking[0],
        "ranking": ranking,
        "scores": scores,
        "perCriterion": breakdown,
        "comparisons": rows,
        "model": verifier_model(),
        "cached": False,
    }
    store.save_selection(
        run_id=run_id,
        cache_key=key,
        session_id=req.session_id,
        problem=req.problem,
        model=verifier_model(),
        criteria_version=req.criteria_version,
        criteria_ids=criteria_ids,
        n_evaluations=req.n_evaluations,
        pivots=req.pivots,
        seed=req.seed,
        candidates=req.candidates,
        comparisons=rows,
        response=response,
    )
    return response


def _trend(scores: list[float]) -> str:
    if len(scores) >= 3 and scores[-3] > scores[-2] > scores[-1] and scores[-3] - scores[-1] >= 0.10:
        return "declining"
    return "stable"


@app.post("/v1/track/{session}/step")
def track_step(session: str, req: TrackStepRequest) -> dict[str, Any]:
    _require_healthy()
    with tracker_lock:
        rows = store.progress_rows(session)
        expected = len(rows) + 1
        if req.step_index != expected:
            raise HTTPException(status.HTTP_409_CONFLICT, f"step_index must be {expected}")
        if rows:
            problem = rows[0]["problem"]
            if req.problem is not None and req.problem != problem:
                raise HTTPException(status.HTTP_409_CONFLICT, "problem does not match the tracked session")
        elif not req.problem:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "problem is required for step 1")
        else:
            problem = req.problem
        try:
            tracker = trackers.get(session)
            if tracker is None:
                tracker = ProgressTracker(
                    problem,
                    n_evaluations=req.n_evaluations,
                    model=verifier_model(),
                )
                for row in rows:
                    tracker.update(row["text"])
                trackers[session] = tracker
            score = tracker.update(req.text)
            store.add_progress(session, problem, req.step_index, req.text, score)
        except Exception as exc:
            trackers.pop(session, None)
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"progress scoring failed: {exc}") from exc
        scores = [row["score"] for row in rows] + [score]
        return {"score": score, "trend": _trend(scores), "stepIndex": req.step_index, "model": verifier_model()}


@app.delete("/v1/track/{session}", status_code=status.HTTP_204_NO_CONTENT)
def delete_track(session: str) -> Response:
    with tracker_lock:
        trackers.pop(session, None)
        store.delete_progress(session)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/v1/track/offline")
def offline_track(req: OfflineTrackRequest) -> dict[str, Any]:
    _require_healthy()
    rows = store.progress_rows(req.session)
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tracked session not found")
    try:
        result = track(
            rows[0]["problem"],
            [row["text"] for row in rows],
            n_evaluations=req.n_evaluations,
            model=verifier_model(),
        )
    except Exception as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"offline scoring failed: {exc}") from exc
    return {"session": req.session, "steps": result.steps, "scores": result.scores, "final": result.final, "model": verifier_model()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="run the logprob capability probe and exit")
    args = parser.parse_args()
    if args.check:
        result = run_probe()
        print(json.dumps({key: value for key, value in result.items() if key != "ok"}, indent=2))
        return 0 if result.get("ok") else 1
    parser.error("start the service with: uvicorn service:app --app-dir scripts/verifier --port 8899")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
