"""Real SDK/factory requests against local HTTP endpoints; no model-provider traffic."""

import asyncio
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import time
import threading
from types import SimpleNamespace

import pytest


@contextmanager
def endpoint(event_duration=0):
    requests = []
    stopped = threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            self.reply({"data": [], "object": "list"})
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, dict(self.headers), body))
            if self.path.endswith("/responses"):
                response = {"id": "resp_test", "object": "response", "created_at": 1,
                            "model": "route-test", "status": "completed", "output": [
                                {"id": "msg_test", "type": "message", "role": "assistant", "status": "completed",
                                 "content": [{"type": "output_text", "text": "ok", "annotations": []}]}]}
                if body.get("stream"):
                    events = [{"type": "response.created", "response": {**response, "status": "in_progress"}},
                              {"type": "response.output_text.delta", "delta": "ok", "output_index": 0,
                               "content_index": 0, "item_id": "msg_test"},
                              {"type": "response.completed", "response": response}]
                    if event_duration:
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.send_header("Connection", "close")
                        self.end_headers()
                        end = time.monotonic() + event_duration
                        try:
                            self.wfile.write(b"data: " + json.dumps(events[0]).encode() + b"\n\n")
                            while time.monotonic() < end and not stopped.is_set():
                                self.wfile.write(b"data: " + json.dumps(events[1]).encode() + b"\n\n")
                                self.wfile.flush()
                                stopped.wait(0.03)
                            self.wfile.write(b"data: " + json.dumps(events[2]).encode() + b"\n\n")
                        except (BrokenPipeError, ConnectionResetError):
                            pass
                        self.close_connection = True
                    else:
                        self.reply_bytes(b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events),
                                         "text/event-stream")
                else:
                    self.reply(response)
                return
            self.reply({"id": "test", "object": "chat.completion", "model": "route-test",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                                     "finish_reason": "stop"}]})
        def reply(self, body):
            self.reply_bytes(json.dumps(body).encode(), "application/json")
        def reply_bytes(self, data, content_type):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        stopped.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def configure(home, monkeypatch, url, proxy):
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # Poison ambient proxies: explicit direct must ignore these.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.delenv("NO_PROXY", raising=False)
    (home / "config.yaml").write_text(
        f"model:\n  default: route-test\n  provider: first\n  context_length: 131072\n"
        f"providers:\n  first:\n    base_url: {url}/v1\n    api_key: first-key\n"
        f"    proxy_url: {proxy}\n    stream: false\n    request_timeout_seconds: 31\n"
        f"  second:\n    base_url: {url}/v1\n    api_key: second-key\n"
        "    proxy_url: ''\n    streaming: true\n    request_timeout_seconds: 47\n"
    )


def make_agent(runtime):
    from hermes_cli.route_controls import runtime_agent_controls
    from run_agent import AIAgent
    return AIAgent(
        model="route-test", provider=runtime["provider"], requested_provider=runtime.get("requested_provider"),
        base_url=runtime["base_url"], api_key=runtime["api_key"], api_mode=runtime.get("api_mode", "chat_completions"),
        **runtime_agent_controls(runtime), enabled_toolsets=[], skip_memory=True,
        skip_context_files=True, quiet_mode=True,
    )


def request(agent):
    client = agent._create_request_openai_client(reason="route_test")
    try:
        response = client.chat.completions.create(
            model="route-test", messages=[{"role": "user", "content": "test"}], stream=False,
        )
        assert response.choices[0].message.content == "ok"
        assert client.timeout == agent._resolved_api_call_timeout()
    finally:
        agent._close_request_openai_client(client, reason="request_complete")


def test_main_same_url_switch_fallback_restore_and_rebuild(tmp_path, monkeypatch):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from agent.route_binding import bind_route_entry, reinstall_runtime_snapshot
    with endpoint() as (url, direct), endpoint() as (proxy, proxied):
        configure(tmp_path / "home", monkeypatch, url, proxy)
        agent = make_agent(resolve_runtime_provider(requested="first", target_model="route-test"))
        try:
            snapshot = dict(agent._primary_runtime)
            assert agent._disable_streaming is True
            assert agent._timeout_provider_id() == "first"
            request(agent)
            assert len(proxied) == 1 and not direct
            assert proxied[0][0] == url + "/v1/chat/completions"
            agent.switch_model("route-test", "second", api_key="second-key", base_url=url + "/v1",
                               api_mode="chat_completions")
            assert agent._disable_streaming is False
            assert agent._resolved_api_call_timeout() == 47
            request(agent)
            assert len(direct) == 1 and len(proxied) == 1
            assert bind_route_entry(agent, {}, "first", "route-test")
            assert agent._disable_streaming is True
            request(agent)
            assert len(proxied) == 2
            # Exercise the inverse used by turn-start restore, not a fabricated snapshot.
            reinstall_runtime_snapshot(agent, snapshot)
            assert agent._timeout_provider_id() == "first"
            assert agent._swap_credential(SimpleNamespace(
                id="rotated", runtime_api_key="first-key", runtime_base_url=agent.base_url))
            request(agent)
            assert len(proxied) == 3
            assert all(record[1]["Authorization"] == "Bearer first-key" for record in proxied)
        finally:
            agent.close()


def test_auxiliary_sync_async_same_url_and_raw_interface(tmp_path, monkeypatch):
    from agent.auxiliary_client import resolve_provider_client, _to_async_client
    with endpoint() as (url, direct), endpoint() as (proxy, proxied):
        configure(tmp_path / "home", monkeypatch, url, proxy)
        first, _ = resolve_provider_client("first", model="route-test", raw_codex=True)
        second, _ = resolve_provider_client("second", model="route-test", raw_codex=True)
        try:
            first.chat.completions.create(model="route-test", messages=[])
            async def run():
                client, _ = _to_async_client(first, "route-test")
                try:
                    assert client._hermes_aux_transport_provider == "first"
                    assert callable(client.responses.create)
                    await client.chat.completions.create(model="route-test", messages=[])
                finally:
                    await client.close()
                client, _ = _to_async_client(second, "route-test")
                try:
                    await client.chat.completions.create(model="route-test", messages=[])
                finally:
                    await client.close()
            asyncio.run(run())
            assert len(proxied) == 2 and len(direct) == 1
            assert all(record[1]["Authorization"] == "Bearer first-key" for record in proxied)
            assert direct[0][1]["Authorization"] == "Bearer second-key"
        finally:
            first.close()
            second.close()


def test_named_responses_wire_raw_wrapped_async_and_main(tmp_path, monkeypatch):
    from agent.auxiliary_client import resolve_provider_client, _to_async_client
    from hermes_cli.runtime_provider import resolve_runtime_provider
    with endpoint() as (url, direct), endpoint() as (proxy, proxied):
        home = tmp_path / "home"
        configure(home, monkeypatch, url, proxy)
        path = home / "config.yaml"
        path.write_text(path.read_text().replace("    api_key: first-key", "    api_key: first-key\n    api_mode: codex_responses"))
        raw, _ = resolve_provider_client("first", model="route-test", raw_codex=True)
        wrapped, _ = resolve_provider_client("first", model="route-test")
        agent = make_agent(resolve_runtime_provider(requested="first", target_model="route-test"))
        try:
            assert raw.responses.create(model="route-test", input="test").status == "completed"
            result = wrapped.chat.completions.create(model="route-test", messages=[{"role": "user", "content": "test"}])
            assert result.choices[0].message.content == "ok"
            async def run():
                client, _ = _to_async_client(raw, "route-test")
                try:
                    assert (await client.responses.create(model="route-test", input="test")).status == "completed"
                finally:
                    await client.close()
                client, _ = _to_async_client(wrapped, "route-test")
                result = await client.chat.completions.create(model="route-test", messages=[{"role": "user", "content": "test"}])
                assert result.choices[0].message.content == "ok"
            asyncio.run(run())
            result = agent._interruptible_api_call({"model": "route-test", "input": [{"role": "user", "content": "test"}]})
            assert result.output_text == "ok"
            assert len(proxied) == 5 and not direct
            assert all(record[0] == url + "/v1/responses" for record in proxied)
        finally:
            raw.close()
            wrapped.close()
            agent.close()


@pytest.mark.parametrize("async_mode", [False, True])
def test_real_proxy_connection_failure_retries_direct(tmp_path, monkeypatch, async_mode):
    from agent.process_bootstrap import build_keepalive_http_client
    with endpoint() as (url, direct), socket.socket() as unavailable:
        unavailable.bind(("127.0.0.1", 0))  # bound but not listening: deterministic refusal
        proxy = f"http://127.0.0.1:{unavailable.getsockname()[1]}"
        client = build_keepalive_http_client(url, async_mode=async_mode,
                                            proxy_url=proxy, proxy_fallback_to_direct=True)
        if async_mode:
            async def run():
                try:
                    result = await client.post(url + "/v1/responses", json={"input": "test"})
                    assert result.status_code == 200
                finally:
                    await client.aclose()
            asyncio.run(run())
        else:
            try:
                assert client.post(url + "/v1/responses", json={"input": "test"}).status_code == 200
            finally:
                client.close()
        assert len(direct) == 1
        assert direct[0][0] == "/v1/responses"
