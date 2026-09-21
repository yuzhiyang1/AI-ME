"""验证真实供应商请求结构与恶意/损坏响应的拒绝边界。"""

import asyncio
import json

import httpx
import pytest

from aime.application.ports.model_gateway import (
    LlmFinishReason,
    LlmStreamCompleted,
    LlmTextDelta,
    ModelDescriptor,
)
from aime.domain.browser import BrowserAction, BrowserError, BrowserSnapshot, parse_snapshot
from aime.infrastructure.browser_models import (
    GatewayBrowserTextGenerator,
    TypeSafeBrowserPlanner,
    validate_choice,
)


@pytest.mark.parametrize("answer", [
    None, {}, {"choice": "missing", "probabilities": {"a": 1}, "confidence": 1},
    {"choice": "a", "probabilities": {"a": float("nan")}, "confidence": 1},
    {"choice": "a", "probabilities": {"a": 1}, "confidence": float("inf")},
    {"choice": "a", "probabilities": {"a": True}, "confidence": 1},
    {"choice": "a", "probabilities": {"a": 0.4}, "confidence": 1},
    {"choice": "a", "probabilities": {"a": 1, "extra": 0}, "confidence": 1},
])
def test_invalid_probability_distributions_are_rejected(answer):
    with pytest.raises(BrowserError):
        validate_choice(answer, {"a"})


def test_choice_must_be_argmax_and_confidence_finite():
    with pytest.raises(BrowserError):
        validate_choice({"choice": "a", "probabilities": {"a": 0.1, "b": 0.9},
                         "confidence": 0.9}, {"a", "b"})
    assert validate_choice({"choice": "a", "probabilities": {"a": 1},
                            "confidence": 0.7}, {"a"}) == ("a", 0.7)


async def test_typesafe_real_endpoint_and_selected_target_head():
    observed = BrowserSnapshot("snapshot", "https://fixture.test", "页面", "Search", (
        BrowserAction("input-1", "fill", "Search", value=""),
        BrowserAction("button-1", "click", "Search"),
    ))

    async def respond(request):
        assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
        assert request.headers["authorization"] == "Bearer fake-secret"
        body = json.loads(request.content)
        assert set(body["state"]) == {"page", "elements", "recent_actions"}
        assert body["model"] == "jev-latest"
        assert body["questions"]["type_text_target"]["criteria"].keys() == {"1"}
        return httpx.Response(200, json={"answers": {
            "operation": {"choice": "TYPE_TEXT", "confidence": 0.9,
                          "probabilities": {"TYPE_TEXT": 0.9, "CLICK": 0.05,
                                            "DONE": 0.03, "BLOCKED": 0.02}},
            "type_text_target": {"choice": "1", "confidence": 0.8, "probabilities": {"1": 1}},
            "click_target": {"invalid": "unused head must not break selected action"},
        }})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await TypeSafeBrowserPlanner(client, "fake-secret").choose(observed, "搜索", [])
    assert result.action_id == "input-1"
    assert result.confident()


@pytest.mark.parametrize("response", [{}, [], {"answers": {}}, {"answers": {"operation": []}}])
async def test_malformed_typesafe_response_never_selects_an_action(response):
    async with httpx.AsyncClient(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json=response),
    )) as client:
        with pytest.raises(BrowserError):
            await TypeSafeBrowserPlanner(client, "key").choose(
                BrowserSnapshot("s", "url", "title", "text", ()), "goal", [],
            )


def test_duplicate_observation_actions_are_rejected():
    action = {"id": "same", "kind": "click", "label": "Search"}
    with pytest.raises(BrowserError):
        parse_snapshot({"snapshotId": "s", "url": "url", "title": "", "text": "",
                        "actions": [action, action]})


async def test_text_uses_existing_model_and_closes_cancelled_stream():
    started, closed = asyncio.Event(), asyncio.Event()

    class Gateway:
        def list_models(self):
            return [ModelDescriptor("test", "text", "text", 128000)]

        async def stream(self, request):
            assert request.model_ref == "test/text"
            try:
                started.set()
                await asyncio.Event().wait()
                yield LlmTextDelta('unused')
            finally:
                closed.set()

    generator = GatewayBrowserTextGenerator(Gateway())
    task = asyncio.create_task(generator.generate(
        BrowserSnapshot("s", "url", "title", "text", ()),
        BrowserAction("a", "fill", "Search"), "goal", None,
    ))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()


@pytest.mark.parametrize("text", ['{"text":""}', '{"text":42}', 'plain', '{"text":"ok","x":1}'])
async def test_text_malformed_result_is_not_typed(text):
    class Gateway:
        def list_models(self):
            return [ModelDescriptor("test", "text", "text", 128000)]

        async def stream(self, request):
            yield LlmTextDelta(text)
            yield LlmStreamCompleted(LlmFinishReason.STOP)

    with pytest.raises(BrowserError):
        await GatewayBrowserTextGenerator(Gateway()).generate(
            BrowserSnapshot("s", "url", "title", "text", ()),
            BrowserAction("a", "fill", "Search"), "goal", None,
        )
