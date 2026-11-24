"""Goal auto routing keeps the final named transport identity; no model requests."""

import asyncio
from types import SimpleNamespace

import pytest


@pytest.fixture
def routes(tmp_path, monkeypatch):
    import agent.auxiliary_client as auxiliary
    from hermes_cli import config

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    path = tmp_path / "config.yaml"
    # Same endpoint AND credential: neither can distinguish these transport policies.
    path.write_text(
        "model:\n  default: route-test\n  provider: second\n"
        "providers:\n"
        "  first:\n    base_url: http://127.0.0.1:56789/v1\n    api_key: shared-test-key\n"
        "    proxy_url: http://127.0.0.1:56780\n    stream: false\n"
        "  second:\n    base_url: http://127.0.0.1:56789/v1\n    api_key: shared-test-key\n"
        "    proxy_url: ''\n    stream: true\n",
        encoding="utf-8",
    )
    config._LOAD_CONFIG_CACHE.clear()
    config._RAW_CONFIG_CACHE.clear()
    auxiliary.shutdown_cached_clients()
    yield path
    auxiliary.shutdown_cached_clients()


def goal_snapshot(provider):
    from gateway.run_goals import _remember_goal_main_runtime_snapshot, _consume_goal_main_runtime_snapshot
    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider(requested=provider, target_model="route-test")
    assert runtime["provider"] == "custom"
    agent = SimpleNamespace(
        provider=runtime["provider"], requested_provider=runtime["requested_provider"],
        model="route-test", base_url=runtime["base_url"], api_key=runtime["api_key"],
        api_mode=runtime["api_mode"], _timeout_provider=runtime["timeout_provider"],
        _provider_streaming=runtime["streaming"],
    )
    runner = SimpleNamespace(_is_session_run_current=lambda key, generation: generation == 1)
    _remember_goal_main_runtime_snapshot(runner, "owning-session", 1, agent)
    snapshot = _consume_goal_main_runtime_snapshot(runner, "owning-session", 1)
    assert snapshot is not None
    return snapshot


@pytest.mark.parametrize("async_mode", [False, True])
def test_goal_auto_named_policy_survives_sdk_rebuild_and_cache(routes, monkeypatch, async_mode):
    import agent.auxiliary_client as auxiliary
    import agent.process_bootstrap as bootstrap
    import openai

    controls = []
    sdk_clients = []
    build_http = bootstrap.build_keepalive_http_client
    sync_sdk, async_sdk = auxiliary.OpenAI, openai.AsyncOpenAI

    def http_spy(base_url, **kwargs):
        client = build_http(base_url, **kwargs)
        controls.append((kwargs.get("async_mode", False), kwargs.get("proxy_url"), client))
        return client

    def sync_spy(**kwargs):
        client = sync_sdk(**kwargs)
        sdk_clients.append((False, client, kwargs))
        return client

    def async_spy(**kwargs):
        client = async_sdk(**kwargs)
        sdk_clients.append((True, client, kwargs))
        return client

    monkeypatch.setattr(bootstrap, "build_keepalive_http_client", http_spy)
    monkeypatch.setattr(auxiliary, "OpenAI", sync_spy)
    monkeypatch.setattr(openai, "AsyncOpenAI", async_spy)

    async def check():
        first_runtime, second_runtime = goal_snapshot("first"), goal_snapshot("second")
        first, model = auxiliary._get_cached_client(
            "auto", main_runtime=first_runtime, task="goal_judge", async_mode=async_mode,
        )
        second, _ = auxiliary._get_cached_client(
            "auto", main_runtime=second_runtime, task="goal_judge", async_mode=async_mode,
        )
        first_again, _ = auxiliary._get_cached_client(
            "auto", main_runtime=first_runtime, task="goal_judge", async_mode=async_mode,
        )
        try:
            # Assert transport kwargs at the actual HTTP/SDK seam, not a mocked resolver.
            expected = [(False, "http://127.0.0.1:56780")]
            if async_mode:
                expected.append((True, "http://127.0.0.1:56780"))
            expected.append((False, ""))
            if async_mode:
                expected.append((True, ""))
            assert [(mode, proxy) for mode, proxy, _ in controls] == expected
            assert model == "route-test"
            assert first is not None and second is not None
            assert first is first_again and first is not second
            assert first._hermes_aux_effective_provider == "first"
            assert second._hermes_aux_effective_provider == "second"
            assert first._hermes_aux_transport_provider == "first"
            assert second._hermes_aux_transport_provider == "second"
            for mode, client, kwargs in sdk_clients:
                assert kwargs["http_client"] is next(
                    http for http_mode, _, http in controls if http_mode == mode and http is kwargs["http_client"]
                )
                assert kwargs["api_key"] == "shared-test-key"
                assert kwargs["base_url"].rstrip("/") == "http://127.0.0.1:56789/v1"
                assert str(client.base_url).rstrip("/") == "http://127.0.0.1:56789/v1"
                assert kwargs["max_retries"] == 0
            assert all(http._trust_env is False for _, proxy, http in controls if proxy == "")
        finally:
            auxiliary._client_cache.clear()
            for mode, client, _ in sdk_clients:
                if mode:
                    await client.close()
                else:
                    client.close()

    asyncio.run(check())


def test_goal_auto_cache_follows_logical_route_and_live_policy(routes):
    import agent.auxiliary_client as auxiliary
    from hermes_cli import config

    # Equal endpoint/key/policy/request: the live logical binding must still split cache entries.
    routes.write_text(routes.read_text().replace("http://127.0.0.1:56780", "''"))
    config._LOAD_CONFIG_CACHE.clear()
    config._RAW_CONFIG_CACHE.clear()
    first_runtime = goal_snapshot("first")
    second_runtime = dict(first_runtime, timeout_provider="second")
    first, _ = auxiliary._get_cached_client("auto", main_runtime=first_runtime, task="goal_judge")
    second, _ = auxiliary._get_cached_client("auto", main_runtime=second_runtime, task="goal_judge")
    assert first is not second
    routes.write_text(routes.read_text().replace("    proxy_url: ''", "    proxy_url: http://127.0.0.1:56781", 1))
    config._LOAD_CONFIG_CACHE.clear()
    config._RAW_CONFIG_CACHE.clear()
    rebuilt, _ = auxiliary._get_cached_client("auto", main_runtime=first_runtime, task="goal_judge")
    assert rebuilt is not first


def test_goal_auto_actual_fallback_beats_stale_requested_provider(routes):
    import agent.auxiliary_client as auxiliary
    from gateway.run_goals import _goal_main_runtime_from_agent

    # A concrete fallback provider is authoritative even if the request names an old route.
    snapshot = _goal_main_runtime_from_agent(SimpleNamespace(
        provider="openrouter", requested_provider="first", _timeout_provider="openrouter",
        model="fallback-model", base_url="http://127.0.0.1:56790/v1", api_key="fallback-test-key",
        api_mode="chat_completions",
    ))
    client, model = auxiliary._get_cached_client("auto", main_runtime=snapshot, task="goal_judge")
    assert client is not None
    assert model == "fallback-model"
    assert client._hermes_aux_effective_provider == "openrouter"
    assert str(client.base_url).rstrip("/") == "http://127.0.0.1:56790/v1"
    assert client.api_key == "fallback-test-key"


def test_goal_auto_custom_fallback_uses_current_logical_identity(routes):
    import agent.auxiliary_client as auxiliary
    from gateway.run_goals import _goal_main_runtime_from_agent

    runtime = goal_snapshot("second")
    snapshot = _goal_main_runtime_from_agent(SimpleNamespace(
        **{key: value for key, value in runtime.items() if key != "timeout_provider"},
        _timeout_provider="second",
    ))
    assert snapshot is not None
    # Simulate stale original request on a custom-wire fallback with a concrete logical identity.
    snapshot["requested_provider"] = "first"
    client, _ = auxiliary._get_cached_client("auto", main_runtime=snapshot, task="goal_judge")
    assert client is not None
    assert client._hermes_aux_effective_provider == "second"
    assert client._hermes_aux_transport_provider == "second"
