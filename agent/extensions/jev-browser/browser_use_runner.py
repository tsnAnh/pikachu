#!/usr/bin/env python3
"""JSONL runner for the pinned Browser Use agent using Pi as its chat model."""
from __future__ import annotations

import asyncio
import json
import signal
import sys
import time
import urllib.request
from typing import Any, TypeVar

from pydantic import BaseModel
from browser_use import Agent, BrowserSession  # pyright: ignore[reportMissingImports]
from browser_use.llm.messages import BaseMessage  # pyright: ignore[reportMissingImports]
from browser_use.llm.views import ChatInvokeCompletion, ChatInvokeUsage  # pyright: ignore[reportMissingImports]

MODEL = "openai-codex/gpt-5.6-sol"
CDP_URL = "http://127.0.0.1:9223"
MAX_STEPS = 30
MAX_HISTORY = 30
T = TypeVar("T", bound=BaseModel)


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def receive() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Pi closed the Browser Use bridge")
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise RuntimeError("Pi sent invalid bridge JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError("Pi sent an invalid bridge message")
    return value


def targets() -> list[dict[str, Any]]:
    with urllib.request.urlopen(f"{CDP_URL}/json/list", timeout=5) as response:
        value = json.load(response)
    return [item for item in value if isinstance(item, dict) and item.get("type") == "page"]


def normalize_messages(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for message in messages:
        content = message.content
        parts: list[dict[str, Any]] = []
        if isinstance(content, str):
            parts.append({"type": "text", "text": content})
        elif content:
            for part in content:
                if part.type == "text":
                    parts.append({"type": "text", "text": part.text})
                elif part.type == "image_url":
                    parts.append({"type": "image", "url": part.image_url.url, "media_type": part.image_url.media_type})
                elif part.type == "refusal":
                    parts.append({"type": "text", "text": part.refusal})
        normalized.append({"role": message.role, "content": parts})
    return normalized


async def update_virtual_cursor(current_agent: Any) -> None:
    if not current_agent.history.history:
        return
    results = current_agent.history.history[-1].result
    for result in reversed(results):
        metadata = result.metadata if isinstance(result.metadata, dict) else {}
        x = metadata.get("click_x", metadata.get("input_x"))
        y = metadata.get("click_y", metadata.get("input_y"))
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            page = await current_agent.browser_session.get_current_page()
            if page is not None:
                await page.evaluate("(x, y) => window.__pikachuMoveCursor?.(x, y, true)", x, y)
            return

class PiChatModel:
    model = MODEL
    _verified_api_keys = True

    @property
    def provider(self) -> str:
        return "pi"

    @property
    def name(self) -> str:
        return MODEL

    async def ainvoke(self, messages: list[BaseMessage], output_format: type[T] | None = None, **_kwargs: Any) -> ChatInvokeCompletion[T] | ChatInvokeCompletion[str]:
        request_id = f"model-{time.monotonic_ns()}"
        schema = output_format.model_json_schema() if output_format else None
        emit({"type": "model_request", "id": request_id, "messages": normalize_messages(messages), "schema": schema, "model": MODEL})
        response = await asyncio.to_thread(receive)
        if response.get("type") != "model_response" or response.get("id") != request_id:
            raise RuntimeError("Pi returned an unexpected model response")
        if response.get("error"):
            raise RuntimeError(f"Pi model bridge failed: {response['error']}")
        completion: Any = response.get("completion")
        if output_format is not None:
            completion = output_format.model_validate(completion)
        elif not isinstance(completion, str):
            raise ValueError("Pi model bridge returned a non-text completion")
        raw_value = response.get("usage")
        raw_usage: dict[str, Any] = raw_value if isinstance(raw_value, dict) else {}
        prompt = int(raw_usage.get("input", raw_usage.get("promptTokens", 0)) or 0)
        generated = int(raw_usage.get("output", raw_usage.get("completionTokens", 0)) or 0)
        usage = ChatInvokeUsage(prompt_tokens=prompt, prompt_cached_tokens=None, prompt_cache_creation_tokens=None, prompt_image_tokens=None, completion_tokens=generated, total_tokens=prompt + generated)
        return ChatInvokeCompletion(completion=completion, usage=usage, stop_reason="end_turn")


async def run() -> None:
    start = receive()
    if start.get("type") != "start":
        raise ValueError("First bridge message must be start")
    url, goal = start.get("url"), start.get("goal")
    if not isinstance(url, str) or not isinstance(goal, str) or not url.strip() or not goal.strip():
        raise ValueError("A non-empty URL and goal are required")
    started = time.perf_counter()
    before = targets()
    before_ids = {str(item.get("id")) for item in before}
    browser = BrowserSession(cdp_url=CDP_URL, keep_alive=True)
    task = f"Use the currently selected tab. Navigate it in place to {url.strip()}, then: {goal.strip()} Preserve all existing tabs and do not close the browser."
    agent = Agent(task=task, llm=PiChatModel(), browser_session=browser, use_vision=True)
    try:
        emit({"type": "progress", "status": "starting", "url": url, "actions": 0})
        async def on_step_end(current_agent: Any) -> None:
            await update_virtual_cursor(current_agent)
            emit({
                "type": "progress",
                "status": "running",
                "url": await current_agent.browser_session.get_current_page_url(),
                "actions": current_agent.state.n_steps,
            })
        history = await agent.run(max_steps=MAX_STEPS, on_step_end=on_step_end)
        final_url = await browser.get_current_page_url()
        title = await browser.get_current_page_title()
        after = targets()
        after_ids = {str(item.get("id")) for item in after}
        missing = sorted(before_ids - after_ids)
        if missing:
            raise RuntimeError(f"Browser Use unexpectedly closed pre-existing tab(s): {', '.join(missing)}")
        actions = history.action_names()[-MAX_HISTORY:]
        errors = [error for error in history.errors() if error][-MAX_HISTORY:]
        emit({
            "type": "result", "engine": "browser-use", "status": "completed" if history.is_done() else "stopped",
            "url": final_url, "title": title, "final_result": history.final_result(),
            "actions": [{"step": index + 1, "kind": "browser-use", "action": action} for index, action in enumerate(actions)],
            "errors": errors, "elapsed_ms": round((time.perf_counter() - started) * 1000), "model": MODEL,
            "tabs_before": sorted(before_ids), "tabs_after": sorted(after_ids),
        })
    finally:
        await agent.close()


def main() -> int:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: [task.cancel() for task in asyncio.all_tasks(loop)])
    try:
        loop.run_until_complete(run())
        return 0
    except asyncio.CancelledError:
        emit({"type": "error", "error": "Browser Use automation cancelled"})
        return 130
    except Exception as error:
        emit({"type": "error", "error": f"{type(error).__name__}: {error}"})
        return 1
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


if __name__ == "__main__":
    raise SystemExit(main())
