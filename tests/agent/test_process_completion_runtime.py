"""Actual registry/RPC/tool-executor path, with no model or network request."""
import copy
import json
from types import SimpleNamespace

import pytest
from openai.types.chat import ChatCompletionMessage

from agent.context_compressor import _DB_PERSISTED_MARKER
from agent.process_completions import ProcessCompletionInbox
from gateway.process_completions import build_process_batch
from gateway.run_notifications import GatewayNotificationsMixin
from gateway.session_context import clear_session_vars, set_session_vars
from hermes_state import SessionDB
from run_agent import AIAgent
from tools.approval_context import reset_current_session_key, set_current_session_key


def tool_round(agent, messages, name, arguments, call_id, owner):
    response = ChatCompletionMessage(role="assistant", content=None, tool_calls=[{
        "id": call_id, "type": "function", "function": {
            "name": name, "arguments": json.dumps(arguments),
        },
    }])
    messages.append(response.model_dump(exclude_none=True))
    agent._execute_tool_calls(response, messages, owner)
    return messages[-1]


@pytest.mark.parametrize("launch_path", ["direct", "execute_code"])
def test_real_tool_boundary_and_bridge_ownership(tmp_path, monkeypatch, launch_path):
    import tools.process_registry as pr
    from tools.code_kernel import shutdown_all_kernels

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("HERMES_YOLO_MODE", "1")
    (tmp_path / "config.yaml").write_text("terminal:\n  backend: local\napprovals:\n  mode: 'off'\ncompression:\n  enabled: false\nmodel:\n  context_length: 128000\n")
    registry = pr.ProcessRegistry()
    monkeypatch.setattr(pr, "process_registry", registry)
    parent, key = f"boundary-{launch_path}", f"agent:main:telegram:dm:{launch_path}"
    tokens = set_session_vars(platform="telegram", chat_id=launch_path, chat_type="dm",
                              session_key=key, session_id=parent, cwd=str(tmp_path))
    approval_token = set_current_session_key(key)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(parent, source="telegram", model="runtime-probe")
    agent = AIAgent(model="runtime-probe", api_key="non-network-test-key",
                    base_url="http://127.0.0.1:1/v1", provider="custom",
                    session_id=parent, session_db=db, quiet_mode=True, skip_memory=True,
                    skip_context_files=True, enabled_toolsets=["terminal", "code_execution"])
    agent._process_completion_inbox = ProcessCompletionInbox()
    messages = [{"role": "user", "content": "isolated boundary probe"}]
    try:
        # The launch is dispatched by AIAgent; execute_code calls the actual RPC
        # terminal bridge back into the SAME registry, not a separate child registry.
        for consumed in (False, True):
            before_ids = set(registry._running) | set(registry._finished)
            command = "printf 'bridge-real-output\\n'"
            if launch_path == "direct":
                name, args = "terminal", {"command": command, "background": True, "notify": True}
            else:
                name, args = "execute_code", {"code": (
                    "from hermes_tools import terminal\n"
                    # The existing generated helper is foreground-only. Its real
                    # timeout>600 promotion is the supported route to a tracked
                    # background process without changing helper/tool schemas.
                    f"print(terminal(command={command!r}, timeout=601))"
                )}
            launched = tool_round(agent, messages, name, args, f"launch-{consumed}", parent)
            ids = (set(registry._running) | set(registry._finished)) - before_ids
            assert len(ids) == 1, launched
            session = registry.get(ids.pop())
            assert session._completion_event.wait(10)
            assert session.owner_task_id == parent
            assert session.parent_session_id == parent
            assert session.session_key == key
            evt = GatewayNotificationsMixin._build_process_completion_event(
                {"session_key": key, "parent_session_id": parent, "platform": "telegram", "chat_id": launch_path},
                session, session.id,
            )
            agent._process_completion_inbox.add(build_process_batch([evt]))
            prior = copy.deepcopy(messages)
            if consumed:
                row = tool_round(agent, messages, "process", {
                    "action": "wait", "session_id": session.id, "timeout": 2,
                }, "wait-real-process", parent)
                assert "INTERNAL PROCESS RESULTS" not in row["content"]
                assert "bridge-real-output" in row["content"]
            else:
                row = tool_round(agent, messages, "terminal", {
                    "command": "printf 'foreground-safe-boundary\\n'", "timeout": 10,
                }, "foreground-real-call", parent)
                assert "INTERNAL PROCESS RESULTS" in row["content"]
                assert session.id in row["content"]
                assert row["tool_call_id"] == "foreground-real-call"
                assert row["display_metadata"]["internal_process_completions"][0]["session_id"] == session.id
            assert messages[:len(prior)] == prior
            assert row.get(_DB_PERSISTED_MARKER)
            saved = db.get_messages(parent)
            assert any(m.get("role") == "tool" and session.id in str(m.get("content")) for m in saved)
            assert registry.is_completion_consumed(session.id)
            print(json.dumps({"launch_path": launch_path, "process_id": session.id,
                              "owner": session.owner_task_id, "session_key": session.session_key,
                              "exit_code": session.exit_code, "wait_consumed": consumed,
                              "inline": "INTERNAL PROCESS RESULTS" in row["content"],
                              "persisted_tool_rows": sum(m.get("role") == "tool" for m in saved)}))
    finally:
        shutdown_all_kernels()
        agent.close()
        db.close()
        reset_current_session_key(approval_token)
        clear_session_vars(tokens)
