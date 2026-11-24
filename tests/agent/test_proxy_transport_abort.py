"""Proxy-fallback wrappers must not hide live sockets from request deadline aborts."""

import socket
import pytest


@pytest.mark.parametrize("failed_proxy", [False, True])
def test_proxy_fallback_socket_is_reachable_by_request_abort(failed_proxy):
    from tests.agent.test_route_transport_integration import endpoint
    from agent.process_bootstrap import build_keepalive_http_client
    from agent.agent_runtime_helpers import force_close_tcp_sockets
    with endpoint(event_duration=2.0) as (url, _), socket.socket() as unavailable:
        unavailable.bind(("127.0.0.1", 0))
        proxy = f"http://127.0.0.1:{unavailable.getsockname()[1]}" if failed_proxy else url
        with build_keepalive_http_client(url, proxy_url=proxy, proxy_fallback_to_direct=True) as client:
            with client.stream("POST", url + "/v1/responses", json={"stream": True}) as response:
                assert response.status_code == 200
                assert force_close_tcp_sockets(client) >= 1
