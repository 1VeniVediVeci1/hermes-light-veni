"""Real SDK/SSE bounds on both worker and cron-inline Responses requests."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

import pytest

from tests.agent.test_route_transport_integration import configure, make_agent


@contextmanager
def stream_endpoint(mode):
    stop = threading.Event()
    seen = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            response = {"id": "resp_test", "object": "response", "created_at": 1,
                        "model": "route-test", "status": "completed", "output": []}

            def send(event):
                self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\n")
                self.wfile.flush()

            created = {"type": "response.created", "response": {**response, "status": "in_progress"}}
            delta = {"type": "response.output_text.delta", "delta": "ok", "output_index": 0,
                     "content_index": 0, "item_id": "msg_test"}
            try:
                if body["input"] == "warmup":
                    send(created)
                    send(delta)
                    send({"type": "response.completed", "response": response})
                    return
                if mode == "no_event":
                    stop.wait(5.0)
                else:
                    send(created)
                    if mode != "lifecycle":
                        send(delta)
                    if mode == "idle":
                        stop.wait(5.0)
                    else:
                        end = time.monotonic() + 5.0
                        while time.monotonic() < end and not stop.wait(0.03):
                            send(created if mode == "lifecycle" else delta)
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
@pytest.mark.parametrize("boundary", ["explicit", "hard", "budget", "lifecycle", "no_event", "idle", "cancel"])
def test_real_stream_keeps_deadlines_and_cancellation(tmp_path, monkeypatch, platform, boundary):
    from agent import chat_completion_helpers as h
    from hermes_cli.runtime_provider import resolve_runtime_provider

    mode = "idle" if boundary == "cancel" else boundary if boundary in {"lifecycle", "no_event", "idle"} else "active"
    with stream_endpoint(mode) as (url, seen):
        home = tmp_path / "home"
        configure(home, monkeypatch, url, "http://127.0.0.1:1")
        path = home / "config.yaml"
        path.write_text(path.read_text().replace("    api_key: second-key",
                                               "    api_key: second-key\n    api_mode: codex_responses"))
        agent = make_agent(resolve_runtime_provider(requested="second", target_model="route-test"))
        agent.platform = platform
        args = {"model": "route-test", "input": "test"}
        aborts, shutdowns, calls, closes = [], [], [], []
        closed = threading.Event()
        caller_tid = threading.get_ident()
        real_stream = agent._run_codex_stream
        real_abort = agent._abort_request_openai_client
        real_shutdown = agent._force_close_tcp_sockets
        real_close = agent._close_request_openai_client
        cancel_timer = threading.Timer(0.1, agent.interrupt)

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
            # Genuine warmup removes cold import latency from these sub-second bounds.
            assert agent._interruptible_api_call({**args, "input": "warmup"}).status == "completed"
            monkeypatch.setattr(agent, "_run_codex_stream", stream)
            monkeypatch.setattr(agent, "_abort_request_openai_client", abort)
            monkeypatch.setattr(agent, "_force_close_tcp_sockets", shutdown)
            monkeypatch.setattr(agent, "_close_request_openai_client", close)
            if boundary != "explicit":
                monkeypatch.setattr(agent, "_compute_non_stream_stale_timeout", lambda kwargs: 5.0)
            monkeypatch.setattr(h, "CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS", 0.6)
            if boundary == "explicit":
                # Real named-provider config, not a patched explicitness predicate.
                path.write_text(path.read_text().replace("    streaming: true",
                                                        "    stale_timeout_seconds: 0.6\n    streaming: true"))

            elif boundary == "hard":
                monkeypatch.setenv("HERMES_CODEX_HARD_TIMEOUT_SECONDS", "0.6")
            elif boundary == "budget":
                agent.run_budget_seconds = 0.6
                agent._run_budget_started_at = time.time()
            elif boundary == "no_event":
                monkeypatch.setenv("HERMES_CODEX_TTFB_TIMEOUT_SECONDS", "0.6")
            elif boundary == "idle":
                monkeypatch.setenv("HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS", "0.6")
            elif boundary == "cancel":
                agent.stream_delta_callback = lambda text: cancel_timer.start()

            expected = InterruptedError if boundary == "cancel" else TimeoutError
            with pytest.raises(expected):
                agent._interruptible_api_call(args)
            reasons = {"lifecycle": "codex_progress_kill", "no_event": "codex_ttfb_kill",
                       "idle": "codex_stream_idle_kill", "cancel": "interrupt_abort"}
            assert reasons.get(boundary, "stale_call_kill") in aborts
            assert agent._active_codex_stream_request_token is None
            assert len(seen) == 2  # Retired physical attempts must not reconnect.
            assert closed.wait(timeout=3.0)
            assert closes and all(tid == calls[0] for tid, _ in closes)
            assert all(reason == "request_error_cleanup" for _, reason in closes)
            assert (calls == [caller_tid]) if platform == "cron" else (calls[0] != caller_tid)
            if boundary != "cancel":
                assert any(count > 0 for count in shutdowns), "Watchdog must actually shutdown the live socket"
            if platform == "cron":
                assert agent._active_request_abort is None
        finally:
            cancel_timer.cancel()
            if cancel_timer.ident is not None:
                cancel_timer.join(timeout=3.0)
            agent.close()
