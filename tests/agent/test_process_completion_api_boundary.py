"""Loopback protocol fixture: real API assembly + real tools, not an external LLM."""
import asyncio
import copy
import json
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

from gateway.config import Platform
from gateway.run import GatewayRunner
from gateway.session import SessionSource
from gateway.session_context import clear_session_vars, set_session_vars
from hermes_state import SessionDB
from run_agent import AIAgent
from tools.approval_context import reset_current_session_key, set_current_session_key


def test_completion_arriving_during_api_reaches_next_request_without_new_user(tmp_path, monkeypatch):
    import tools.process_registry as pr
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    (tmp_path / "config.yaml").write_text(
        "terminal:\n  backend: local\napprovals:\n  mode: 'off'\n"
        "compression:\n  enabled: false\nmodel:\n  context_length: 128000\n")
    registry = pr.ProcessRegistry()
    monkeypatch.setattr(pr, "process_registry", registry)
    parent, key = "api-boundary-parent", "agent:main:telegram:dm:43"
    tokens = set_session_vars(platform="telegram", chat_id="43", chat_type="dm",
                              session_key=key, session_id=parent, cwd=str(tmp_path))
    approval_token = set_current_session_key(key)
    session = registry.spawn_local("printf 'api-crossing-real-result\\n'", task_id=parent,
                                   owner_task_id=parent, session_key=key)
    assert session._completion_event.wait(10)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(parent, source="telegram", model="loopback-fixture")
    runner = object.__new__(GatewayRunner)
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="43", chat_type="dm")
    adapter = SimpleNamespace(_pending_messages={})
    state = SimpleNamespace(turn=SimpleNamespace(agent=None), conversation=SimpleNamespace(queued_events=[]))
    runner.adapters = {Platform.TELEGRAM: adapter}
    runner._completion_delivery_lock = threading.Lock()
    runner._completion_deliveries_inflight = set()
    runner._completion_deliveries_delivered = OrderedDict()
    runner._completion_delivery_retention = 2048
    runner._build_process_event_source = lambda event: source
    runner._resolve_injection_adapter = lambda platform_name, source=None: adapter
    runner._delivery_adapter_for = lambda source: adapter
    runner._peek_session_state = lambda session_key: state
    runner._session_state = lambda session_key: state
    async def inbound(event):
        assert await runner._handle_active_session_busy_message(event, key)
    adapter.handle_message = inbound
    event = runner._build_process_completion_event(
        {"session_key": key, "parent_session_id": parent, "platform": "telegram", "chat_id": "43"},
        session, session.id)
    requests = []
    errors = []

    class ScriptedProtocolFixture(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(copy.deepcopy(request))
                if len(requests) == 1:
                    # Arrival while the actual API request is in flight. The handler
                    # has no authority to interrupt the agent or manufacture tool rows.
                    assert asyncio.run(runner._inject_watch_notification("receipt", event)) is True
                    message = {"role": "assistant", "content": None, "tool_calls": [{
                        "id": "fixture-provider-tool-call", "type": "function", "function": {
                            "name": "terminal", "arguments": json.dumps({"command": "printf 'safe-boundary-tool\\n'", "timeout": 10})}}]}
                    reason = "tool_calls"
                else:
                    message = {"role": "assistant", "content": "protocol fixture completed"}
                    reason = "stop"
                body = json.dumps({"id": f"fixture-{len(requests)}", "object": "chat.completion",
                                   "created": 1, "model": "loopback-fixture", "choices": [{
                                       "index": 0, "message": message, "finish_reason": reason}],
                                   "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except BaseException as error:
                errors.append(error)
                self.send_error(500)

    server = ThreadingHTTPServer(("127.0.0.1", 0), ScriptedProtocolFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    agent = AIAgent(model="loopback-fixture", api_key="protocol-fixture-key", provider="custom",
                    base_url=f"http://127.0.0.1:{server.server_port}/v1", session_id=parent,
                    session_db=db, enabled_toolsets=["terminal"], max_iterations=3,
                    skip_memory=True, skip_context_files=True, quiet_mode=True)
    state.turn.agent = agent
    agent._disable_streaming = True
    try:
        result = agent.run_conversation("exercise the real safe boundary", task_id=parent)
        assert not errors
        assert result["completed"], result
        primary_requests = [request for request in requests if not request.get("response_format")]
        assert len(primary_requests) == 2, requests  # session titling may make a separate auxiliary request
        first, second = [r["messages"] for r in primary_requests]
        assert first == second[:len(first)]  # byte-equivalent prefix, including system prompt
        assert [r["role"] for r in second] == ["system", "user", "assistant", "tool"]
        tool = second[-1]
        assert tool["tool_call_id"] == "fixture-provider-tool-call"
        assert "INTERNAL PROCESS RESULTS" in tool["content"]
        assert session.id in tool["content"] and "api-crossing-real-result" in tool["content"]
        assert "display_metadata" not in tool
        assert "OUT-OF-BAND USER MESSAGE" not in tool["content"]
        assert registry.is_completion_consumed(session.id)
        pending = adapter._pending_messages.pop(key)
        assert runner._promote_queued_event(key, adapter, pending) is None
        print(json.dumps({"api_boundary_process": session.id, "requests": len(requests),
                          "wire_roles": [r["role"] for r in second], "prefix_unchanged": first == second[:len(first)],
                          "duplicate_wake": False, "provider": "scripted-loopback-protocol-fixture"}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        agent.close()
        db.close()
        reset_current_session_key(approval_token)
        clear_session_vars(tokens)
