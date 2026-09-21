#!/usr/bin/env python3
"""JSON-lines bridge between Pi and the pinned jev-ultrafast Python package."""

from __future__ import annotations

import json
import signal
import sys
import time
from typing import Any

import jev_ultrafast.agent as agent_module  # pyright: ignore[reportMissingImports]
from jev_ultrafast import Agent  # pyright: ignore[reportMissingImports]

MAX_TEXT_LENGTH = 2000
TEXT_MODEL = "openai-codex/gpt-5.6-sol"


def interrupted(_signum: int, _frame: Any) -> None:
    raise InterruptedError("Browser automation interrupted")

def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def receive() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Pi closed the Jev browser bridge")
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise RuntimeError("Pi sent invalid bridge JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("Pi sent an invalid bridge message")
    return value


def field_text(context: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    request_id = f"text-{time.monotonic_ns()}"
    started = time.perf_counter()
    emit({"type": "text_request", "id": request_id, "context": context})
    response = receive()
    if response.get("type") != "text_response" or response.get("id") != request_id:
        raise RuntimeError("Pi returned an unexpected text-helper response")
    if response.get("error"):
        raise RuntimeError(f"Sol text helper failed: {response['error']}")
    text = response.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
        raise ValueError("Sol returned no valid field value; nothing typed.")
    return text, {
        "model": TEXT_MODEL,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": response.get("usage", {}),
    }


def action_summary(state: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "step": item.get("step"),
            "kind": item.get("kind"),
            "action": item.get("action"),
            "text": item.get("text"),
            "url": item.get("url"),
        }
        for item in state.get("history", [])
    ]


def main() -> int:
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        start = receive()
        if start.get("type") != "start":
            raise ValueError("First bridge message must be start")
        url = start.get("url")
        goal = start.get("goal")
        if not isinstance(url, str) or not isinstance(goal, str) or not url.strip() or not goal.strip():
            raise ValueError("A non-empty URL and goal are required")

        agent_module.field_text = field_text
        with Agent(url.strip(), goal.strip()) as browser_agent:
            state = browser_agent.snapshot()
            emit({"type": "progress", "status": state["status"], "url": state["page"]["url"], "actions": 0})
            for state in browser_agent.run():
                emit(
                    {
                        "type": "progress",
                        "status": state["status"],
                        "url": state["page"]["url"],
                        "actions": len(state["history"]),
                    }
                )
            emit(
                {
                    "type": "result",
                    "status": state["status"],
                    "url": state["page"]["url"],
                    "page_text": state["page"].get("text", "")[:20000],
                    "title": state["page"].get("title", ""),
                    "elapsed_ms": state["elapsed_ms"],
                    "actions": action_summary(state),
                    "text_models": sorted(
                        {call.get("model") for call in state.get("text_calls", []) if call.get("model")}
                    ),
                }
            )
        return 0
    except Exception as error:  # The parent renders a bounded diagnostic.
        emit({"type": "error", "error": f"{type(error).__name__}: {error}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
