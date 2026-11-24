"""Named auxiliary routes must project reasoning for their resolved wire protocol."""

import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest
import hermes_yaml as yaml


_PROVIDER = "fixture-relay"
_BASE_URL = "https://relay.example.test/v1"
_MODEL = "claude-opus-4-8"


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    from agent import auxiliary_client as ac

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    ac.shutdown_cached_clients()
    try:
        yield home
    finally:
        ac.shutdown_cached_clients()


@pytest.fixture
def wire_requests(monkeypatch):
    """Use real SDK serialization and parsing, replacing only the HTTP transport."""
    captured = []

    def respond(request):
        body = json.loads(request.content)
        captured.append((request.url.path, body))
        if request.url.path == "/v1/messages":
            message = {
                "id": "msg_fixture", "type": "message", "role": "assistant",
                "model": _MODEL, "content": [], "stop_reason": None,
                "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0},
            }
            events = [
                {"type": "message_start", "message": message},
                {"type": "content_block_start", "index": 0,
                 "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0,
                 "delta": {"type": "text_delta", "text": "ok"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                 "usage": {"output_tokens": 1}},
                {"type": "message_stop"},
            ]
            sse = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, json={
            "id": "chatcmpl_fixture", "object": "chat.completion", "created": 1,
            "model": _MODEL, "choices": [{"index": 0, "finish_reason": "stop",
                                         "message": {"role": "assistant", "content": "ok"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda self, request: transport.handle_request(request))

    async def async_respond(self, request):
        return await transport.handle_async_request(request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_respond)
    return captured


def _prepare(home, api_mode, reasoning_config, async_mode=False):
    from agent import auxiliary_client as ac

    config = {
        "model": {"provider": _PROVIDER, "default": _MODEL},
        "providers": {_PROVIDER: {"base_url": _BASE_URL, "api_key": "fixture-key",
                                  "transport": api_mode}},
        "auxiliary": {"moa_reference": {"provider": _PROVIDER, "model": _MODEL,
                                         "api_mode": api_mode}},
    }
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    return ac._prepare_aux_request(
        "moa_reference", provider=None, model=None, base_url=None, api_key=None,
        main_runtime={}, messages=[{"role": "user", "content": "Reply ok."}],
        temperature=None, max_tokens=128, tools=None, timeout=5, extra_body=None,
        reasoning_config=reasoning_config, extra_headers=None, api_mode=None,
        route_info=None, async_mode=async_mode,
    )


@pytest.mark.parametrize("async_mode", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize(
    "reasoning_config,expected_thinking,expected_effort",
    [
        ({"enabled": True, "effort": "max", "exclude": False}, "adaptive", "max"),
        ({"enabled": True, "effort": "xhigh"}, "adaptive", "xhigh"),
        ({"enabled": True, "effort": "ultra"}, "adaptive", "max"),
        ({"enabled": False}, "disabled", None),
        (None, None, None),
    ],
    ids=["max", "xhigh", "ultra", "disabled", "unspecified"],
)
def test_named_messages_route_preserves_reasoning_through_http(
    isolated_home, wire_requests, async_mode, reasoning_config, expected_thinking, expected_effort,
):
    from agent import auxiliary_client as ac

    original = copy.deepcopy(reasoning_config)
    req = _prepare(isolated_home, "anthropic_messages", reasoning_config, async_mode)
    expected_client = ac.AsyncAnthropicAuxiliaryClient if async_mode else ac.AnthropicAuxiliaryClient
    assert isinstance(req.client, expected_client)
    assert req.resolved_api_mode == "anthropic_messages"
    assert req.client.base_url.rstrip("/") == _BASE_URL

    if async_mode:
        response = asyncio.run(req.client.chat.completions.create(**req.kwargs))
    else:
        response = req.client.chat.completions.create(**req.kwargs)

    assert response.choices[0].message.content == "ok"
    assert len(wire_requests) == 1
    path, body = wire_requests[0]
    assert path == "/v1/messages"
    assert body["max_tokens"] == 128
    if expected_thinking is None:
        assert "thinking" not in body
    else:
        assert body["thinking"]["type"] == expected_thinking
    if expected_effort is None:
        assert "output_config" not in body
    else:
        assert body["output_config"]["effort"] == expected_effort
    assert "reasoning_effort" not in body
    assert "reasoning" not in body
    assert "_reasoning_config" not in body
    assert req.kwargs.get("_reasoning_config") == original
    assert reasoning_config == original


def test_named_chat_route_keeps_openai_reasoning_projection(isolated_home, wire_requests):
    from agent import auxiliary_client as ac

    req = _prepare(isolated_home, "chat_completions", {"enabled": True, "effort": "max"})
    assert not isinstance(req.client, ac.AnthropicAuxiliaryClient)
    assert req.resolved_api_mode == "chat_completions"
    response = req.client.chat.completions.create(**req.kwargs)

    assert response.choices[0].message.content == "ok"
    assert len(wire_requests) == 1
    path, body = wire_requests[0]
    assert path == "/v1/chat/completions"
    assert body["reasoning_effort"] == "max"
    assert "_reasoning_config" not in req.kwargs
    assert "_reasoning_config" not in body
    assert "thinking" not in body
    assert "output_config" not in body
    assert "reasoning" not in body
