from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class Store:
    def __init__(self, path: str | os.PathLike[str] | None = None) -> None:
        default = Path(__file__).with_name("plan-verify.sqlite3")
        self.path = Path(path or os.environ.get("PLAN_VERIFY_DB", default))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        return db

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = self.connect()
        try:
            with db:
                yield db
        finally:
            db.close()

    def _init(self) -> None:
        with self.connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS response_cache (
                    cache_key TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    cache_key TEXT NOT NULL UNIQUE,
                    session_id TEXT,
                    problem TEXT NOT NULL,
                    model TEXT NOT NULL,
                    criteria_version TEXT NOT NULL,
                    criteria_ids_json TEXT NOT NULL,
                    n_evaluations INTEGER NOT NULL,
                    pivots INTEGER NOT NULL,
                    seed INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS candidates (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    candidate_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    PRIMARY KEY (run_id, candidate_index)
                );

                CREATE TABLE IF NOT EXISTS comparisons (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    criterion_id TEXT NOT NULL,
                    candidate_a INTEGER NOT NULL,
                    candidate_b INTEGER NOT NULL,
                    repetition INTEGER NOT NULL,
                    score_a REAL NOT NULL,
                    score_b REAL NOT NULL,
                    PRIMARY KEY (
                        run_id, criterion_id, candidate_a, candidate_b, repetition
                    )
                );

                CREATE TABLE IF NOT EXISTS progress (
                    session_id TEXT NOT NULL,
                    problem TEXT NOT NULL,
                    step_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    score REAL NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (session_id, step_index)
                );
                """
            )

    def get_cached(self, cache_key: str) -> dict[str, Any] | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT response_json FROM response_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def put_cached(self, cache_key: str, kind: str, response: dict[str, Any]) -> None:
        with self.connection() as db:
            db.execute(
                """
                INSERT OR REPLACE INTO response_cache(cache_key, kind, response_json)
                VALUES (?, ?, ?)
                """,
                (cache_key, kind, json.dumps(response, sort_keys=True)),
            )

    def save_selection(
        self,
        *,
        run_id: str,
        cache_key: str,
        session_id: str | None,
        problem: str,
        model: str,
        criteria_version: str,
        criteria_ids: list[str],
        n_evaluations: int,
        pivots: int,
        seed: int,
        candidates: list[str],
        comparisons: list[dict[str, Any]],
        response: dict[str, Any],
    ) -> None:
        with self.connection() as db:
            db.execute(
                """
                INSERT INTO runs(
                    id, cache_key, session_id, problem, model, criteria_version,
                    criteria_ids_json, n_evaluations, pivots, seed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    cache_key,
                    session_id,
                    problem,
                    model,
                    criteria_version,
                    json.dumps(criteria_ids),
                    n_evaluations,
                    pivots,
                    seed,
                ),
            )
            db.executemany(
                "INSERT INTO candidates(run_id, candidate_index, text) VALUES (?, ?, ?)",
                [(run_id, index, text) for index, text in enumerate(candidates)],
            )
            db.executemany(
                """
                INSERT INTO comparisons(
                    run_id, criterion_id, candidate_a, candidate_b, repetition,
                    score_a, score_b
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        run_id,
                        row["criterion"],
                        row["a"],
                        row["b"],
                        row["rep"],
                        row["scoreA"],
                        row["scoreB"],
                    )
                    for row in comparisons
                ],
            )
            db.execute(
                "INSERT INTO response_cache(cache_key, kind, response_json) VALUES (?, 'select', ?)",
                (cache_key, json.dumps(response, sort_keys=True)),
            )

    def load_selection(self, cache_key: str) -> dict[str, Any] | None:
        with self.connection() as db:
            run = db.execute("SELECT * FROM runs WHERE cache_key = ?", (cache_key,)).fetchone()
            if not run:
                return None
            candidates = db.execute(
                "SELECT text FROM candidates WHERE run_id = ? ORDER BY candidate_index",
                (run["id"],),
            ).fetchall()
            comparisons = db.execute(
                """
                SELECT criterion_id, candidate_a, candidate_b, repetition, score_a, score_b
                FROM comparisons WHERE run_id = ?
                ORDER BY criterion_id, candidate_a, candidate_b, repetition
                """,
                (run["id"],),
            ).fetchall()
        return {
            "runId": run["id"],
            "criteriaIds": json.loads(run["criteria_ids_json"]),
            "nEvaluations": run["n_evaluations"],
            "pivots": run["pivots"],
            "seed": run["seed"],
            "candidates": [row["text"] for row in candidates],
            "comparisons": [
                {
                    "criterion": row["criterion_id"],
                    "a": row["candidate_a"],
                    "b": row["candidate_b"],
                    "rep": row["repetition"],
                    "scoreA": row["score_a"],
                    "scoreB": row["score_b"],
                }
                for row in comparisons
            ],
        }

    def progress_rows(self, session_id: str) -> list[dict[str, Any]]:
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT problem, step_index, text, score FROM progress
                WHERE session_id = ? ORDER BY step_index
                """,
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def add_progress(
        self, session_id: str, problem: str, step_index: int, text: str, score: float
    ) -> None:
        with self.connection() as db:
            db.execute(
                """
                INSERT INTO progress(session_id, problem, step_index, text, score)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, problem, step_index, text, score),
            )

    def delete_progress(self, session_id: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM progress WHERE session_id = ?", (session_id,))
