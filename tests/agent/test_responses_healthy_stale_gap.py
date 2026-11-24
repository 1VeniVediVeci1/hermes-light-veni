"""Actual parsed HTTP Responses SSE must outlive the implicit stale wall budget."""

import pytest


@pytest.mark.parametrize("platform", ["cli", "cron"])
def test_healthy_responses_events_outlive_implicit_stale(tmp_path, monkeypatch, platform):
    from tests.agent.test_route_transport_integration import endpoint, configure, make_agent
    from hermes_cli.runtime_provider import resolve_runtime_provider
    with endpoint(event_duration=2.0) as (url, direct):
        home = tmp_path / "home"
        configure(home, monkeypatch, url, "http://127.0.0.1:1")
        path = home / "config.yaml"
        path.write_text(path.read_text().replace("    api_key: second-key", "    api_key: second-key\n    api_mode: codex_responses"))
        agent = make_agent(resolve_runtime_provider(requested="second", target_model="route-test"))
        agent.platform = platform
        # Scale the implicit budget, not the watchdog/SDK: real events still traverse
        # httpx -> OpenAI SSE parser -> run_codex_stream -> the live request owner.
        try:
            # Warm real SDK/client/Relay setup before shrinking the deadline: otherwise
            # a cold import can expire 0.2s before HTTP dispatch, not during healthy SSE.
            assert agent._interruptible_api_call({"model": "route-test", "input": "warmup"}).status == "completed"
            monkeypatch.setattr(agent, "_compute_non_stream_stale_timeout", lambda kwargs: 0.2)
            result = agent._interruptible_api_call({"model": "route-test", "input": "test"})
            assert result.status == "completed"
            # The assembler can label EOF-with-deltas as completed; only the
            # terminal frame supplies this id, so partial EOF cannot pass here.
            assert result.id == "resp_test"
            assert len(result.output_text) > len("ok")
            assert len(direct) == 2
        finally:
            agent.close()
