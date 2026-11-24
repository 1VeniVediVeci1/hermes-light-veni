"""Logical provider identity for auxiliary routes backed by a live main runtime."""

from typing import Any


def main_route_provider(runtime: dict[str, Any], fallback: str = "") -> str:
    """Recover a named custom route without overriding an actual non-custom fallback."""
    provider = str(runtime.get("provider") or fallback or "")
    if provider != "custom":
        return provider
    # The live binding wins over the original request after a fallback/model switch.
    identity = str(runtime.get("timeout_provider") or runtime.get("requested_provider") or "")
    if identity and identity not in {"auto", "custom"}:
        from hermes_cli.runtime_provider import _get_named_custom_provider

        if _get_named_custom_provider(identity) is not None:
            return identity
    return provider
