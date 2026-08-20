from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parents[2]
TEST_DIR = tempfile.TemporaryDirectory()
os.environ["PLAN_VERIFY_DB"] = str(Path(TEST_DIR.name) / "test.sqlite3")
os.environ["PLAN_VERIFY_ROOT"] = str(ROOT)
os.environ["LLM_VERIFIER_MODEL"] = "test-model"
sys.path.insert(0, str(Path(__file__).parent))

import service  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi import Response  # noqa: E402
from store import Store  # noqa: E402


class FakeVerifierHandler(BaseHTTPRequestHandler):
    expose_logprobs = True

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        last = payload.get("messages", [{}])[-1]
        prefill = last.get("role") == "assistant"
        content = "A" if prefill else "Analysis complete."
        alternatives = [
            {"token": chr(65 + index), "logprob": -float(index + 1), "bytes": [65 + index]}
            for index in range(20)
        ]
        logprobs = None
        if self.expose_logprobs:
            logprobs = {
                "content": [
                    {
                        "token": "A",
                        "logprob": -1.0,
                        "bytes": [65],
                        "top_logprobs": alternatives,
                    }
                ]
            }
        response = {
            "id": "fake",
            "object": "chat.completion",
            "created": 0,
            "model": payload.get("model", "test-model"),
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                    "logprobs": logprobs,
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        encoded = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class FakeServer:
    def __init__(self, logprobs: bool) -> None:
        handler = type("ConfiguredHandler", (FakeVerifierHandler,), {"expose_logprobs": logprobs})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()


class FakeTracker:
    def __init__(self, _problem: str, **_kwargs: object) -> None:
        self.count = 0

    def update(self, _text: str) -> float:
        self.count += 1
        return max(0.0, 0.8 - self.count * 0.1)


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        service.store = Store(Path(TEST_DIR.name) / f"{self.id().split('.')[-1]}.sqlite3")
        service.trackers.clear()
        service.health_state = {"ok": True, "model": "test-model", "logprobs": True}

    def test_health_requires_real_score_token_logprobs(self) -> None:
        with FakeServer(logprobs=True) as url:
            os.environ["OPENAI_BASE_URL"] = url
            result = service.run_probe()
            self.assertTrue(result["ok"])
            self.assertGreaterEqual(result["scoreTokenCoverage"]["<score_A>"], 2)
        with FakeServer(logprobs=False) as url:
            os.environ["OPENAI_BASE_URL"] = url
            result = service.run_probe()
            self.assertFalse(result["ok"])
            self.assertFalse(result["logprobs"])
            response = Response()
            service.healthz(response)
            self.assertEqual(response.status_code, 503)

    def test_single_candidate_uses_both_orientations(self) -> None:
        calls: list[tuple[str, str]] = []

        def fake_compare(_problem: str, a: str, b: str, **_kwargs: object) -> tuple[float, float]:
            calls.append((a, b))
            return (0.8, 0.2)

        original = service.compare
        service.compare = fake_compare
        try:
            request = service.ScoreRequest(problem="task", candidate="candidate")
            result = service._score_candidate(
                request,
                [{"id": "groundedness", "name": "Groundedness", "description": "Grounded"}],
                "Trust evidence.",
            )
        finally:
            service.compare = original
        self.assertEqual(calls, [("candidate", service.NULL_PLAN), (service.NULL_PLAN, "candidate")])
        self.assertAlmostEqual(result["score"], 0.5)

    def test_cache_key_covers_criteria_version_and_model(self) -> None:
        path = ROOT / "agent" / "criteria" / "plan" / "v1.md"
        payload = {"problem": "task", "candidates": ["a", "b", "c"], "pivots": 2, "seed": 0}
        first = service._cache_key("select", payload, path, "plan/v1")
        normalized = service._cache_key(
            "select",
            {**payload, "problem": "task  \r\n"},
            path,
            "plan/v1",
        )
        second = service._cache_key("select", payload, path, "plan/v2")
        os.environ["LLM_VERIFIER_MODEL"] = "different-model"
        third = service._cache_key("select", payload, path, "plan/v1")
        os.environ["LLM_VERIFIER_MODEL"] = "test-model"
        self.assertEqual(first, normalized)
        self.assertEqual(len({first, second, third}), 3)

    def test_non_monotonic_progress_is_conflict(self) -> None:
        original = service.ProgressTracker
        service.ProgressTracker = FakeTracker
        try:
            first = service.track_step(
                "session",
                service.TrackStepRequest(step_index=1, text="inspect", problem="chosen plan"),
            )
            self.assertEqual(first["stepIndex"], 1)
            with self.assertRaises(HTTPException) as caught:
                service.track_step("session", service.TrackStepRequest(step_index=1, text="duplicate"))
        finally:
            service.ProgressTracker = original
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(service._trend([0.80, 0.74, 0.69]), "declining")
        self.assertEqual(service._trend([0.80, 0.76, 0.72]), "stable")

    def test_persisted_rows_replay_without_a_model(self) -> None:
        rows = []
        for a, b in ((0, 1), (1, 2), (2, 0), (0, 2), (1, 0), (2, 1)):
            rows.append(
                {
                    "criterion": "groundedness",
                    "a": a,
                    "b": b,
                    "rep": 0,
                    "scoreA": 0.9 if a == 0 else 0.4,
                    "scoreB": 0.9 if b == 0 else 0.4,
                }
            )
        first = service._rank_from_rows(rows, 3, ["groundedness"], 1, 2, 0)
        second = service._rank_from_rows(json.loads(json.dumps(rows)), 3, ["groundedness"], 1, 2, 0)
        self.assertEqual(first, second)
        self.assertEqual(first[0][0], 0)

    def test_select_replays_persisted_library_comparisons(self) -> None:
        request = service.SelectRequest(
            problem="Choose a grounded plan.",
            candidates=["Plan A", "Plan B", "Plan C"],
            criteria_path=str(ROOT / "agent" / "criteria" / "plan" / "v1.md"),
            n_evaluations=1,
            pivots=1,
            seed=7,
        )
        with FakeServer(logprobs=True) as url:
            os.environ["OPENAI_BASE_URL"] = url
            self.assertTrue(service.run_probe()["ok"])
            first = service.select_endpoint(request)
        second = service.select_endpoint(request)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(first["ranking"], second["ranking"])
        self.assertEqual(first["scores"], second["scores"])
        self.assertGreater(len(first["comparisons"]), 0)


if __name__ == "__main__":
    unittest.main()
