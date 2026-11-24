"""Resolved transport controls survive gateway route assembly and cache boundaries."""

import pytest


def config(home, monkeypatch, stream="false", proxy="''"):
    monkeypatch.setenv("HERMES_HOME", str(home))
    path = home / "config.yaml"
    path.write_text(
        "model:\n  default: route-test\n  provider: first\n  streaming: true\n"
        "providers:\n  first:\n    base_url: https://relay.invalid/v1\n    api_key: test-key\n"
        f"    stream: {stream}\n    proxy_url: {proxy}\n    request_timeout_seconds: 31\n"
        "  second:\n    base_url: https://relay.invalid/v1\n    api_key: other-key\n"
        "    stream: true\n    request_timeout_seconds: 47\n"
    )
    return path


def test_session_override_and_turn_constructor_controls_are_live(tmp_path, monkeypatch):
    from tests.gateway.test_session_model_override_routing import _make_runner
    from gateway.run import _runtime_agent_kwargs
    from hermes_cli.runtime_provider import resolve_runtime_provider
    config(tmp_path, monkeypatch)
    runner = _make_runner()
    key = "session-test"
    runtime = _runtime_agent_kwargs(resolve_runtime_provider(requested="first", target_model="route-test"))
    assert runtime["provider_streaming"] is False
    assert runtime["timeout_provider"] == "first"
    runner._session_model_overrides[key] = {**runtime, "model": "route-test"}
    model, effective = runner._resolve_session_agent_runtime(session_key=key, user_config={})
    route = runner._resolve_turn_agent_config("test", model, effective)
    assert route["runtime"]["provider_streaming"] is False
    assert route["runtime"]["timeout_provider"] == "first"
    first_signature = runner._agent_config_signature(model, effective, [], "")
    # A config edit from False to absent/None clears the old in-memory route override.
    config(tmp_path, monkeypatch, stream="null")
    model, effective = runner._resolve_session_agent_runtime(session_key=key, user_config={})
    assert effective["provider_streaming"] is None
    assert runner._agent_config_signature(model, effective, [], "") != first_signature


@pytest.mark.parametrize("field,values", [
    ("provider_streaming", [None, False, True]),
    ("timeout_provider", ["first", "second", "unknown"]),
])
def test_agent_signature_distinguishes_route_control_identity(tmp_path, monkeypatch, field, values):
    from gateway.run_agent_cache import GatewayAgentCacheMixin
    config(tmp_path, monkeypatch)
    base = {"base_url": "https://relay.invalid/v1", "provider": "custom", "requested_provider": "first"}
    signatures = {GatewayAgentCacheMixin._agent_config_signature("route-test", {**base, field: value}, [], "")
                  for value in values}
    assert len(signatures) == len(values)


def test_live_proxy_policy_invalidates_gateway_auxiliary_and_moa_cache(tmp_path, monkeypatch):
    from gateway.run_agent_cache import GatewayAgentCacheMixin
    from agent.auxiliary_client import _client_cache_key
    from agent.moa_loop import _slot_runtime
    config(tmp_path, monkeypatch)
    runtime = {"base_url": "https://relay.invalid/v1", "provider": "custom", "timeout_provider": "first"}
    def identities():
        return (GatewayAgentCacheMixin._agent_config_signature("route-test", runtime, [], ""),
                _client_cache_key("first", async_mode=False, model="route-test"),
                _slot_runtime({"provider": "first", "model": "route-test"}))
    first = identities()
    config(tmp_path, monkeypatch, stream="true", proxy="http://user:secret@proxy.invalid:7890")
    second = identities()
    assert first[0] != second[0]
    assert first[1] != second[1]
    assert "secret" not in repr(second[1])
    assert first[2]["streaming"] is False
    assert second[2]["streaming"] is True
