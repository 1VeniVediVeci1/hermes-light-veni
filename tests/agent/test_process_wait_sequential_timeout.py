"""Only bounded process waits own their sequential deadline, including bridge calls."""

from itertools import count
import json
import threading
from types import SimpleNamespace

import pytest

import agent.tool_executor as tool_executor
from tools import process_registry, tool_search


@pytest.fixture
def execution_context(monkeypatch):
    agent = SimpleNamespace(
        _tool_worker_threads=set(),
        _tool_worker_threads_lock=threading.Lock(),
        _interrupt_requested=False,
        _tool_interrupt_reason="user stop",
        _touch_activity=lambda message: None,
    )
    emitted = []
    ticks = count()
    deferred_names = frozenset({process_registry.PROCESS_SCHEMA["name"], "web_extract"})
    monkeypatch.setattr(
        tool_search, "load_config_readonly",
        lambda: SimpleNamespace(effective_defer_tools=deferred_names),
    )
    monkeypatch.setattr(tool_executor, "_tool_search_scoped_names", lambda agent: deferred_names)
    monkeypatch.setattr(tool_executor, "_resolve_sequential_tool_timeout", lambda: 0.5)
    monkeypatch.setattr(
        tool_executor, "time", SimpleNamespace(monotonic=lambda: float(next(ticks)))
    )
    monkeypatch.setattr(tool_executor, "_SEQUENTIAL_INTERRUPT_POLL_SECONDS", 0.01)
    monkeypatch.setattr(
        tool_executor, "_ra", lambda: SimpleNamespace(_set_interrupt=lambda *args, **kwargs: None)
    )
    monkeypatch.setattr(
        tool_executor, "_emit_terminal_post_tool_call",
        lambda agent, **kwargs: emitted.append(kwargs),
    )

    def dispatch(agent, *, execute, function_args, middleware_trace, **kwargs):
        return tool_executor._ManagedToolResult(
            result=execute(function_args), args=function_args,
            middleware_trace=middleware_trace, blocked=False, dispatched=True,
        )

    monkeypatch.setattr(tool_executor, "_run_agent_tool_execution_middleware", dispatch)
    return agent, emitted


def _parsed_call(agent, name, args, wrapper):
    if wrapper == "legacy":
        name, args = "tool_call", {"name": name, "arguments": args}
    elif wrapper == "batch":
        name, args = "tool_call", {"calls": [{"name": name, "arguments": args}]}
    call = SimpleNamespace(
        id="process-wait-call",
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )
    parsed = tool_executor._parse_tool_call(agent, call, flatten_probe=True)
    assert parsed.parse_error is None
    assert parsed.scope_block is None
    return parsed


@pytest.mark.parametrize("wrapper", ["direct", "legacy", "batch"])
@pytest.mark.parametrize(
    "name,args,owns_deadline",
    [
        ("process_manage", {"action": "wait", "session_id": "proc-test", "timeout": 1800}, True),
        ("process_manage", {"action": "wait", "session_id": "proc-test"}, True),
        ("process_manage", {"action": "poll", "session_id": "proc-test"}, False),
        ("process_manage", {"action": "kill", "session_id": "proc-test"}, False),
        ("web_extract", {"urls": ["https://example.com"]}, False),
    ],
)
def test_only_process_wait_survives_expired_generic_deadline(
    execution_context, wrapper, name, args, owns_deadline
):
    """A simulated clock expires the generic guard without a wall-clock race."""
    agent, emitted = execution_context
    parsed = _parsed_call(agent, name, args, wrapper)
    assert parsed.name == name
    assert parsed.args == args
    managed = tool_executor._run_sequential_tool_execution_middleware(
        agent, **parsed.ref("task").middleware_kwargs(), execute=lambda args: "tool result",
    )

    if owns_deadline:
        assert managed.result == "tool result"
        assert managed.args == args
        assert not emitted
    else:
        assert isinstance(managed.result, tool_executor._ToolTimeoutResult)
        assert len(emitted) == 1
        assert emitted[0]["status"] == "timeout"
        assert emitted[0]["error_type"] == "tool_timeout"


@pytest.mark.parametrize("wrapper", ["direct", "batch"])
def test_process_wait_remains_interruptible(execution_context, wrapper):
    """Owning the deadline must not bypass polling, cancellation, or its hook."""
    agent, emitted = execution_context
    release = threading.Event()
    finished = threading.Event()
    parsed = _parsed_call(
        agent, "process_manage",
        {"action": "wait", "session_id": "proc-test", "timeout": 1800}, wrapper,
    )

    def wait(args):
        try:
            assert release.wait(timeout=10), "test failed to release process wait"
            return "late result"
        finally:
            finished.set()

    agent._interrupt_requested = True
    try:
        managed = tool_executor._run_sequential_tool_execution_middleware(
            agent, **parsed.ref("task").middleware_kwargs(), execute=wait,
        )
        assert isinstance(managed.result, tool_executor._ToolCancelledResult)
        assert "user stop" in managed.result
        assert len(emitted) == 1
        assert emitted[0]["status"] == "cancelled"
        assert emitted[0]["error_type"] == "tool_interrupted"
    finally:
        release.set()
        assert finished.wait(timeout=5), "process wait worker did not finish"
