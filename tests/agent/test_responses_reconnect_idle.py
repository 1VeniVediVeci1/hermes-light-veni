"""Explicit event-idle still applies before progress on a physical SSE retry."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import pytest

from tests.agent.test_route_transport_integration import configure, make_agent


@contextmanager
def reconnect_endpoint():
    stop = threading.Event()
    seen = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append(body)
            warmup = body["input"] == "warmup"
            broken = len(seen) == 2
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            if broken:
                self.send_header("Content-Length", "1000000")
            self.end_headers()
            response = {"id": "resp_terminal", "object": "response", "created_at": 1,
                        "model": "route-test", "status": "completed", "output": []}

            def send(event):
                self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\n")
                self.wfile.flush()

            try:
                send({"type": "response.created", "response": {**response, "status": "in_progress"}})
                if warmup or broken:
                    send({"type": "response.output_text.delta", "delta": "ok", "output_index": 0,
                          "content_index": 0, "item_id": "msg_test"})
                if broken:
                    # A real incomplete HTTP body forces run_codex_stream to reconnect.
                    return
                if not warmup:
                    stop.wait(3.0)
                send({"type": "response.completed", "response": response})
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", seen
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3.0)


@pytest.mark.parametrize("platform", ["cli", "cron"])
def test_explicit_idle_after_reconnect_created_without_progress(tmp_path, monkeypatch, platform):
    from agent import chat_completion_helpers as h
    from hermes_cli.runtime_provider import resolve_runtime_provider

    with reconnect_endpoint() as (url, seen):
        home = tmp_path / "home"
        configure(home, monkeypatch, url, "http://127.0.0.1:1")
        path = home / "config.yaml"
        path.write_text(path.read_text().replace("    api_key: second-key",
                                               "    api_key: second-key\n    api_mode: codex_responses"))
        agent = make_agent(resolve_runtime_provider(requested="second", target_model="route-test"))
        agent.platform = platform
        aborts, shutdowns, calls, closes = [], [], [], []
        closed = threading.Event()
        caller_tid = threading.get_ident()
        real_stream = agent._run_codex_stream
        real_abort = agent._abort_request_openai_client
        real_shutdown = agent._force_close_tcp_sockets
        real_close = agent._close_request_openai_client

        def stream(*a, **kw):
            calls.append(threading.get_ident())
            return real_stream(*a, **kw)

        def abort(client, *, reason):
            aborts.append(reason)
            return real_abort(client, reason=reason)

        def shutdown(client):
            count = real_shutdown(client)
            shutdowns.append(count)
            return count

        def close(client, *, reason):
            closes.append((threading.get_ident(), reason))
            try:
                return real_close(client, reason=reason)
            finally:
                closed.set()

        try:
            assert agent._interruptible_api_call({"model": "route-test", "input": "warmup"}).id == "resp_terminal"
            monkeypatch.setenv("HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS", "0.4")
            monkeypatch.setattr(h, "CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS", 8.0)
            monkeypatch.setattr(agent, "_run_codex_stream", stream)
            monkeypatch.setattr(agent, "_abort_request_openai_client", abort)
            monkeypatch.setattr(agent, "_force_close_tcp_sockets", shutdown)
            monkeypatch.setattr(agent, "_close_request_openai_client", close)
            with pytest.raises(TimeoutError, match="no SSE events"):
                agent._interruptible_api_call({"model": "route-test", "input": "probe"})
            assert aborts == ["codex_stream_idle_kill"]
            assert len(seen) == 3  # Warmup, broken stream, created-only retry; no post-retirement retry.
            assert agent._active_codex_stream_request_token is None
            assert any(count > 0 for count in shutdowns)
            assert closed.wait(timeout=3.0)
            assert closes and all(tid == calls[0] for tid, _ in closes)
            assert all(reason == "request_error_cleanup" for _, reason in closes)
            assert (calls == [caller_tid]) if platform == "cron" else (calls[0] != caller_tid)
            if platform == "cron":
                assert agent._active_request_abort is None
        finally:
            agent.close()
