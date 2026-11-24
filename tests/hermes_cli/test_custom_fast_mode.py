"""Explicit custom-model Priority support uses the native per-session switch."""

import json
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from openai import OpenAI

MODEL = "gpt-6.2-astra"
URL = "https://relay.invalid/v1"


@pytest.fixture
def relay(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "config.yaml"
    path.write_text(
        "providers:\n  relay:\n    base_url: https://relay.invalid/v1\n"
        "    api_key: test-key\n    api_mode: codex_responses\n"
        "    models:\n      gpt-6.2-astra:\n        supports_fast_mode: true\n"
        "      gpt-6.2-sol: {}\n"
        "  messages:\n    base_url: https://relay.invalid/v1\n"
        "    api_mode: anthropic_messages\n    models:\n      claude-opus-5.5: {}\n"
    )
    return path


@pytest.mark.parametrize("provider", ["custom", "custom:relay", "relay"])
def test_custom_priority_requires_explicit_model_and_endpoint_opt_in(relay, provider):
    from hermes_cli.models import resolve_fast_mode_overrides as resolve

    assert resolve(MODEL, provider=provider, base_url=URL) == {"service_tier": "priority"}
    assert resolve(MODEL, provider=provider, base_url=URL + "/other") is None
    assert resolve("gpt-6.2-sol", provider=provider, base_url=URL) is None
    assert resolve(MODEL, provider=provider, base_url=URL, tier="ultrafast") is None
    assert resolve("claude-opus-5.5", provider="custom:messages", base_url=URL) is None
    assert resolve(MODEL, provider="messages", base_url=URL) is None
    assert resolve(MODEL, provider="custom:messages", base_url=URL) is None
    assert resolve(MODEL, provider="relay") == {"service_tier": "priority"}  # policy before build
    assert resolve(MODEL, provider="custom") is None
    assert resolve(MODEL, provider="openrouter", base_url=URL) is None


def test_same_endpoint_and_model_does_not_grant_priority_to_sibling(relay):
    from hermes_cli.models import resolve_fast_mode_overrides as resolve

    relay.write_text(relay.read_text() + "      gpt-6.2-astra:\n        supports_fast_mode: true\n")
    assert resolve(MODEL, provider="custom", base_url=URL) is None  # no identity to choose the transport
    assert resolve(MODEL, provider="messages", base_url=URL) is None
    assert resolve(MODEL, provider="relay", base_url=URL) == {"service_tier": "priority"}


def test_desktop_inventory_offers_fast_not_ultrafast(relay):
    from hermes_cli.inventory import _apply_capabilities

    row = {"slug": "relay", "api_url": URL, "models": [MODEL, "gpt-6.2-sol"]}
    _apply_capabilities([row])
    assert row["capabilities"][MODEL]["fast"] is True
    assert not row["capabilities"][MODEL].get("ultrafast")
    assert row["capabilities"]["gpt-6.2-sol"]["fast"] is False


def test_two_desktop_sessions_toggle_and_serialize_independently(relay):
    from tui_gateway import server
    from agent.codex_responses_adapter import _preflight_codex_api_kwargs
    from agent.fast_mode import effective_request_overrides
    from agent.transports.codex import ResponsesApiTransport

    def session(sid):
        agent = SimpleNamespace(model=MODEL, provider="custom", base_url=URL,
                                api_mode="codex_responses", service_tier=None,
                                request_overrides={}, reasoning_config=None, session_id=sid)
        return {"session_key": sid, "agent": agent}

    sessions = {"a": session("a"), "b": session("b")}
    before = relay.read_text()
    sent = []

    def request(req):
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"id": "resp-test", "object": "response",
                                        "created_at": 0, "model": MODEL, "output": [],
                                        "status": "completed"})

    with patch.dict(server._sessions, sessions, clear=True), \
            patch.object(server, "_persist_live_session_runtime"), \
            patch.object(server, "_emit"), \
            patch.object(server, "_write_config_key") as write, \
            OpenAI(base_url=URL, api_key="test-key",
                   http_client=httpx.Client(transport=httpx.MockTransport(request))) as client:
        def toggle(sid, value):
            result = server._methods["config.set"]("test", {"session_id": sid, "key": "fast", "value": value})
            assert "error" not in result, result

        def wire(sid):
            agent = sessions[sid]["agent"]
            kwargs = ResponsesApiTransport().build_kwargs(
                MODEL, [{"role": "user", "content": "OK"}], instructions="Reply OK",
                provider=agent.provider, base_url=URL,
                request_overrides=effective_request_overrides(agent))
            client.responses.create(**_preflight_codex_api_kwargs(kwargs), stream=False)
            return sent[-1].get("service_tier")

        toggle("a", "fast")
        assert (wire("a"), wire("b")) == ("priority", None)
        toggle("b", "fast")
        toggle("a", "normal")
        assert (wire("a"), wire("b")) == (None, "priority")
        assert sessions["a"]["create_service_tier_override"] == ""
        assert sessions["b"]["create_service_tier_override"] == "priority"
        assert server._methods["config.get"]("test", {"session_id": "a", "key": "fast"})["result"]["value"] == "normal"
        assert server._methods["config.get"]("test", {"session_id": "b", "key": "fast"})["result"]["value"] == "fast"
        write.assert_not_called()
    assert relay.read_text() == before


@pytest.mark.parametrize("tier, expected", [("priority", "priority"), ("", None), (None, None)])
def test_desktop_factory_restores_wire_tier(relay, monkeypatch, tier, expected):
    from tui_gateway import server
    from agent.fast_mode import effective_request_overrides

    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    monkeypatch.setattr(server, "_load_reasoning_config", lambda model="": None)
    monkeypatch.setattr(server, "_load_service_tier", lambda: None)
    monkeypatch.setattr(server, "_load_enabled_toolsets", lambda *_a, **_kw: None)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr(server, "_agent_cbs", lambda sid: {})
    runtime = {"provider": "custom", "requested_provider": "custom:relay", "base_url": URL,
               "api_key": "test-key", "api_mode": "codex_responses",
               "request_overrides": {"extra_body": {"other": True}}}
    monkeypatch.setattr(server, "_resolve_agent_model_runtime", lambda *a: (MODEL, runtime))
    with patch("run_agent.AIAgent", side_effect=lambda **kw: SimpleNamespace(**kw)):
        agent = server._make_agent("new", "new", service_tier_override=tier)
    assert effective_request_overrides(agent).get("service_tier") == expected
    assert agent.request_overrides["extra_body"] == {"other": True}
    assert "service_tier" not in runtime["request_overrides"]


def test_prebuild_session_can_pin_custom_fast(relay):
    from tui_gateway import server

    session = {"agent": None, "model_override": {"model": MODEL, "provider": "custom:relay"}}
    with patch.dict(server._sessions, {"draft": session}, clear=True), \
            patch.object(server, "_write_config_key") as write:
        result = server._methods["config.set"]("test", {"session_id": "draft", "key": "fast", "value": "fast"})
        assert "error" not in result, result
        assert session["create_service_tier_override"] == "priority"
        write.assert_not_called()
