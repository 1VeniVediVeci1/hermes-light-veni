"""Deadline precedence, bounded progress handoff, and notice/kill agreement."""

import math
import threading
import time
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("source", ["model", "provider", "environment"])
def test_explicit_responses_deadline_survives_context_and_effort_floors(tmp_path, monkeypatch, source):
    from run_agent import AIAgent
    from agent.chat_completion_helpers import _resolve_nonstream_watchdogs, _resolve_direct_stale_timeout

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_API_CALL_STALE_TIMEOUT", "45")
    config = "{}\n"
    if source == "model":
        config = "providers:\n  custom:\n    stale_timeout_seconds: 30\n    models:\n      route-test:\n        stale_timeout_seconds: 12\n"
        expected = 12.0
    elif source == "provider":
        config = "providers:\n  custom:\n    stale_timeout_seconds: 30\n"
        expected = 30.0
    else:
        expected = 45.0
    (tmp_path / "config.yaml").write_text(config)
    agent = AIAgent(model="route-test", provider="custom", api_mode="codex_responses",
                    base_url="https://responses.example.invalid/v1", api_key="test",
                    enabled_toolsets=[], skip_memory=True, skip_context_files=True, quiet_mode=True,
                    reasoning_config={"enabled": True, "effort": "high"})
    try:
        kwargs = {"input": "x" * 500_000}
        assert agent._compute_non_stream_stale_timeout(kwargs) == expected
        wd = _resolve_nonstream_watchdogs(agent, kwargs)
        assert wd.stale_timeout == wd.wall_timeout(1.0) == expected
        assert _resolve_direct_stale_timeout(agent, kwargs) == expected
    finally:
        agent.close()


@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("local", [False, True])
def test_remaining_budget_caps_floors_and_explicit_deadlines(monkeypatch, explicit, local):
    from agent import chat_completion_helpers as h

    monkeypatch.setattr(h.time, "time", lambda: 100.0)
    agent = SimpleNamespace(api_mode="codex_responses", provider="custom", model="test",
                            base_url="http://127.0.0.1:1234" if local else "https://responses.example.invalid/v1",
                            reasoning_config={"enabled": True, "effort": "high"},
                            run_budget_seconds=100.0, _run_budget_started_at=10.0,
                            _compute_non_stream_stale_timeout=lambda kwargs: 5.0 if not explicit else 1800.0,
                            _stale_timeout_is_explicit=lambda: explicit)
    wd = h._resolve_nonstream_watchdogs(agent, {"input": "x" * 500_000})
    assert wd.stale_timeout <= 10.0
    assert wd.wall_timeout(None) <= 10.0
    assert wd.wall_timeout(99.0) == 10.0
    # Exhaustion is not raised to the old 60s floor, including local implicit inf.
    agent._run_budget_started_at = 0.0
    assert h._resolve_nonstream_watchdogs(agent, {"input": "small"}).total_timeout == 0.0


def test_handoff_always_retains_a_finite_absolute_envelope(monkeypatch):
    from agent.chat_completion_deadlines import responses_total_timeout

    monkeypatch.setenv("HERMES_CODEX_HARD_TIMEOUT_SECONDS", "0")
    for local in (False, True):
        total = responses_total_timeout(SimpleNamespace(), float("inf"), explicit=False, local=local)
        assert 0 < total < math.inf


@pytest.mark.parametrize("platform", ["cli", "cron"])
def test_exhausted_budget_never_dispatches_a_responses_request(tmp_path, monkeypatch, platform):
    from run_agent import AIAgent

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    agent = AIAgent(model="test", provider="custom", api_mode="codex_responses",
                    base_url="https://responses.example.invalid/v1", api_key="test", platform=platform,
                    enabled_toolsets=[], skip_memory=True, skip_context_files=True, quiet_mode=True)
    calls = []
    monkeypatch.setattr(agent, "_create_request_openai_client", lambda **kwargs: calls.append(kwargs))
    agent.run_budget_seconds = 1.0
    agent._run_budget_started_at = time.time() - 2.0
    try:
        with pytest.raises(TimeoutError):
            agent._interruptible_api_call({"model": "test", "input": "test"})
        assert calls == []
        assert getattr(agent, "_active_codex_stream_request_token", None) is None
    finally:
        agent.close()


@pytest.mark.parametrize("requires_progress", [False, True])
def test_reconnect_idle_arming_does_not_reset_attempt_or_absolute_deadlines(requires_progress):
    from agent.chat_completion_wait_notice import codex_watchdog_deadline

    args: dict = dict(stale_timeout=500.0, ttfb_enabled=True, ttfb_timeout=120.0,
                last_event_ts=None, last_progress_ts=None, retry_started_ts=1100.0,
                call_start=1000.0, idle_enabled=True, idle_timeout=30.0,
                idle_requires_progress=requires_progress, elapsed=110.0, progress_timeout=300.0)
    assert codex_watchdog_deadline(**args) == ("TTFB", 110.0)
    args["last_event_ts"] = 1110.0
    assert codex_watchdog_deadline(**args) == (
        ("first progress", 290.0) if requires_progress else ("stream idle", 30.0))
    # Further lifecycle events cannot restart first-progress's physical-attempt origin.
    args.update(last_event_ts=1350.0, elapsed=350.0, idle_enabled=False)
    assert codex_watchdog_deadline(**args) == ("first progress", 50.0)
    args.update(stale_timeout=360.0, idle_enabled=True)
    assert codex_watchdog_deadline(**args) == ("wall-clock stale", 10.0)


def test_progress_handoff_and_reconnect_notice_share_the_kill_deadline():
    from agent import chat_completion_helpers as h
    from agent.chat_completion_nonstream import _NonStreamRequest

    request = _NonStreamRequest.__new__(_NonStreamRequest)
    request.wd = h._NonStreamWatchdogs(stale_timeout=90.0, codex=True, est_tokens=1,
        ttfb_enabled=True, ttfb_timeout=120.0, idle_enabled=True, idle_timeout=30.0,
        idle_requires_progress=False, progress_timeout=300.0, total_timeout=500.0,
        progress_extends_stale=True)
    request.call_start = 1000.0
    state = request.codex_watchdog_state = SimpleNamespace(lock=threading.Lock(),
        last_event_ts=1080.0, last_progress_ts=None, retry_started_ts=None)
    assert request._deadline(80.0) == ("wall-clock stale", 10.0)
    state.last_progress_ts = 1080.0
    assert request._deadline(80.0) == ("stream idle", 30.0)
    state.first_progress_ts = 1080.0
    state.retry_started_ts = 1080.0
    state.last_event_ts = state.last_progress_ts = None
    # The healthy-stream handoff survives reconnect; attempt clocks restart,
    # but the finite total cap does not.
    assert request._deadline(100.0) == ("TTFB", 100.0)
    state.retry_started_ts = 1450.0
    assert request._deadline(490.0) == ("wall-clock stale", 10.0)
    killed = []
    request._stale_kill = killed.append
    assert request._enforce_watchdogs(1500.0)
    assert killed == [500.0]
