"""Proxy fallback boundaries on both httpx transport interfaces."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from agent.proxy_fallback_transport import AsyncProxyFirstFallbackTransport, ProxyFirstFallbackTransport

FAILURES = [httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError, httpx.ReadTimeout,
            httpx.WriteError, httpx.WriteTimeout, httpx.ProxyError, httpx.RemoteProtocolError]


def exercise(async_mode, action):
    async def run():
        cls = AsyncProxyFirstFallbackTransport if async_mode else ProxyFirstFallbackTransport
        t = cls(proxy_url="http://user:secret@proxy.invalid:7890", verify=False, limits=httpx.Limits())
        if async_mode:
            await t.aclose()
        else:
            t.close()
        t._proxy = AsyncMock() if async_mode else MagicMock()
        t._direct = AsyncMock() if async_mode else MagicMock()
        proxy = t._proxy.handle_async_request if async_mode else t._proxy.handle_request
        direct = t._direct.handle_async_request if async_mode else t._direct.handle_request
        async def send(request):
            if async_mode:
                return await t.handle_async_request(request)
            return t.handle_request(request)
        await action(t, proxy, direct, send)
    asyncio.run(run())


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("failure", FAILURES)
def test_allowed_pre_header_failure_replays_identical_request_once(async_mode, failure, caplog):
    async def check(t, proxy, direct, send):
        request = httpx.Request("POST", "https://relay.invalid/v1/responses",
                                headers={"Authorization": "Bearer test"}, content=b"payload")
        proxy.side_effect = failure("contains user:secret@proxy.invalid")
        response = httpx.Response(200, request=request)
        direct.return_value = response
        with caplog.at_level("INFO"):
            assert await send(request) is response
        assert proxy.call_args.args[0] is direct.call_args.args[0] is request
        assert proxy.call_count == direct.call_count == 1
        assert "secret" not in caplog.text
        assert request.content == b"payload"
    exercise(async_mode, check)


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("status", [401, 429, 503])
def test_http_error_is_not_replayed(async_mode, status):
    async def check(t, proxy, direct, send):
        response = httpx.Response(status)
        proxy.return_value = response
        assert await send(httpx.Request("POST", "https://relay.invalid", content=b"x")) is response
        assert direct.call_count == 0
    exercise(async_mode, check)


@pytest.mark.parametrize("async_mode", [False, True])
def test_unbuffered_body_and_direct_failure_are_never_retried(async_mode):
    async def check(t, proxy, direct, send):
        proxy.side_effect = httpx.ProxyError("proxy failed")
        request = httpx.Request("POST", "https://relay.invalid", content=iter([b"x"]))
        with pytest.raises(httpx.ProxyError):
            await send(request)
        assert direct.call_count == 0
        direct.side_effect = httpx.ConnectError("direct failed")
        with pytest.raises(httpx.ConnectError):
            await send(httpx.Request("POST", "https://relay.invalid", content=b"x"))
        assert direct.call_count == 1
    exercise(async_mode, check)


@pytest.mark.parametrize("async_mode", [False, True])
def test_closing_proxy_failure_still_closes_direct(async_mode):
    async def check(t, proxy, direct, send):
        if async_mode:
            t._proxy.aclose.side_effect = RuntimeError("close failed")
            with pytest.raises(RuntimeError):
                await t.aclose()
            t._direct.aclose.assert_awaited_once()
        else:
            t._proxy.close.side_effect = RuntimeError("close failed")
            with pytest.raises(RuntimeError):
                t.close()
            t._direct.close.assert_called_once()
    exercise(async_mode, check)


def test_async_sse_body_failure_does_not_replay():
    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: first\n\n"
            raise httpx.ReadError("body failed")
    async def check(t, proxy, direct, send):
        proxy.return_value = httpx.Response(200, stream=BrokenBody())
        response = await send(httpx.Request("POST", "https://relay.invalid", content=b"x"))
        with pytest.raises(httpx.ReadError):
            await response.aread()
        assert direct.call_count == 0
    exercise(True, check)


@pytest.mark.parametrize("async_mode", [False, True])
def test_explicit_transport_build_failure_is_closed(async_mode):
    from agent.process_bootstrap import build_keepalive_http_client
    with pytest.raises(RuntimeError, match="refusing SDK defaults"):
        build_keepalive_http_client("https://relay.invalid", async_mode=async_mode,
                                    proxy_url="unsupported://user:secret@proxy.invalid")
