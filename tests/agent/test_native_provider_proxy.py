"""Native-protocol providers (no ``base_url`` in ``providers:``) honour proxy-first/direct-retry controls."""

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import pytest

from agent.proxy_fallback_transport import ProxyFirstFallbackTransport
from hermes_cli.route_controls import native_provider_http_client


@pytest.fixture
def origin():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


def _config(entry):
    return {"providers": {"native-relay": entry}}


def test_dead_proxy_falls_back_to_direct_for_native_provider(origin, caplog):
    entry = {"proxy_url": "http://127.0.0.1:1", "proxy_fallback_to_direct": True}
    with patch("hermes_cli.config.load_config", return_value=_config(entry)):
        client = native_provider_http_client("native-relay", origin)
    assert isinstance(client._transport, ProxyFirstFallbackTransport)
    with caplog.at_level("INFO", logger="agent.proxy_fallback_transport"):
        assert client.get(origin).text == "ok"
    assert "retrying direct" in caplog.text
    client.close()


@pytest.mark.parametrize("config", [
    {"providers": {}},
    {"providers": {"native-relay": {"discover_models": False}}},
    {"providers": {"native-relay": "not-a-dict"}},
])
def test_no_controls_leaves_the_client_to_the_provider(config):
    with patch("hermes_cli.config.load_config", return_value=config):
        assert native_provider_http_client("native-relay", "https://relay.invalid") is None
