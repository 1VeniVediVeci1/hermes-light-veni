"""Observe background work for up to 30 minutes without changing its lifetime."""
from types import SimpleNamespace

import pytest

from tools import interrupt
from tools import process_registry as module


class ObservationClock:
    """Advance only during an event wait, so tests need no wall-clock sleep."""

    def __init__(self):
        self.elapsed = 0.0

    def monotonic(self):
        return self.elapsed

    def time(self):
        return self.elapsed

    def wait(self, timeout):
        self.elapsed += timeout
        return False


@pytest.fixture
def observation(monkeypatch):
    registry = module.ProcessRegistry()
    clock = ObservationClock()
    session = module.ProcessSession(
        id="proc_wait_limits", command="bounded-test", task_id="wait-limits", started_at=0.0,
    )
    monkeypatch.setattr(session._completion_event, "wait", clock.wait)
    registry._running[session.id] = session
    monkeypatch.setattr(module, "time", SimpleNamespace(
        monotonic=clock.monotonic, time=clock.time,
    ))
    monkeypatch.setattr(interrupt, "is_interrupted", lambda: False)
    monkeypatch.setattr(interrupt, "consume_yield", lambda _thread_id: False)
    monkeypatch.setenv("TERMINAL_TIMEOUT", "60")
    return registry, session, clock


@pytest.mark.parametrize("requested, expected", [(None, 300), (300, 300), (1800, 1800)])
def test_wait_window_is_independent_of_foreground_timeout(observation, requested, expected):
    registry, session, clock = observation
    result = registry.wait(session.id, timeout=requested)
    assert result["status"] == "timeout"
    assert clock.elapsed == expected
    assert "clamped" not in result["timeout_note"]
    assert result["process_running"] is True
    assert not session.exited
    assert not registry.is_completion_consumed(session.id)


def test_wait_above_maximum_clamps_observation_not_process_lifetime(observation):
    registry, session, clock = observation
    result = registry.wait(session.id, timeout=1801)
    assert result["status"] == "timeout"
    assert clock.elapsed == 1800
    assert "configured limit of 1800s" in result["timeout_note"]
    assert result["process_running"] is True
    assert not session.exited
    assert not registry.is_completion_consumed(session.id)


def test_completed_process_returns_immediately_with_thirty_minute_request(observation):
    registry, session, clock = observation
    session.exited = True
    session.exit_code = 0
    result = registry.wait(session.id, timeout=1800)
    assert result["status"] == "exited"
    assert result["exit_code"] == 0
    assert "timeout_note" not in result
    assert clock.elapsed == 0
    assert registry.is_completion_consumed(session.id)


@pytest.mark.parametrize("requested", [0, -1])
def test_nonpositive_wait_still_rejected(observation, requested):
    registry, session, clock = observation
    result = registry.wait(session.id, timeout=requested)
    assert result["status"] == "error"
    assert clock.elapsed == 0
    assert not session.exited


def test_user_interrupt_releases_long_wait_without_stopping_process(observation, monkeypatch):
    registry, session, clock = observation
    monkeypatch.setattr(interrupt, "is_interrupted", lambda: True)
    result = registry.wait(session.id, timeout=1800)
    assert result["status"] == "interrupted"
    assert clock.elapsed == 0
    assert not session.exited
