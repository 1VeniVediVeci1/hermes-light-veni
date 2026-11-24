"""Opt-in proxy-first transports with one safe direct retry."""

from __future__ import annotations

import logging
from typing import Any

import httpx


logger = logging.getLogger(__name__)

_PRE_RESPONSE_FAILURES = (
    httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError, httpx.ReadTimeout,
    httpx.WriteError, httpx.WriteTimeout, httpx.ProxyError, httpx.RemoteProtocolError,
)


def _replayable(request: httpx.Request) -> bool:
    return isinstance(request.stream, httpx.ByteStream)


class ProxyFirstFallbackTransport(httpx.BaseTransport):
    """Retry exactly one buffered pre-header proxy failure without a proxy."""

    def __init__(self, *, proxy_url: str, verify: Any, limits: httpx.Limits):
        self._proxy = httpx.HTTPTransport(proxy=proxy_url, verify=verify, limits=limits, trust_env=False)
        self._direct = httpx.HTTPTransport(verify=verify, limits=limits, trust_env=False)

    @property
    def _hermes_inner_transports(self) -> tuple:
        """Expose both owned pools to the request-local socket shutdown walker."""
        return self._proxy, self._direct

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return self._proxy.handle_request(request)
        except _PRE_RESPONSE_FAILURES as exc:
            if not _replayable(request):
                raise
            logger.info("LLM proxy route failed before response headers; retrying direct (%s)", type(exc).__name__)
            return self._direct.handle_request(request)

    def close(self) -> None:
        try:
            self._proxy.close()
        finally:
            self._direct.close()


class AsyncProxyFirstFallbackTransport(httpx.AsyncBaseTransport):
    """Async variant with the same pre-header and replayability boundary."""

    def __init__(self, *, proxy_url: str, verify: Any, limits: httpx.Limits):
        self._proxy = httpx.AsyncHTTPTransport(proxy=proxy_url, verify=verify, limits=limits, trust_env=False)
        self._direct = httpx.AsyncHTTPTransport(verify=verify, limits=limits, trust_env=False)

    @property
    def _hermes_inner_transports(self) -> tuple:
        """Expose both owned pools to the request-local socket shutdown walker."""
        return self._proxy, self._direct

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await self._proxy.handle_async_request(request)
        except _PRE_RESPONSE_FAILURES as exc:
            if not _replayable(request):
                raise
            logger.info("LLM proxy route failed before response headers; retrying direct (%s)", type(exc).__name__)
            return await self._direct.handle_async_request(request)

    async def aclose(self) -> None:
        try:
            await self._proxy.aclose()
        finally:
            await self._direct.aclose()
