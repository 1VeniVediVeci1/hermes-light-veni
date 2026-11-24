"""Route-local request controls shared by product entrypoints and cache identities.

These are core runtime seams, not plugin observer hooks. Protocol-specific SDK
transports remain owned by their official adapters.
"""


def runtime_agent_controls(runtime: dict) -> dict:
    return {
        "provider_streaming": runtime.get("streaming", runtime.get("provider_streaming")),
        "timeout_provider": (runtime.get("timeout_provider") or runtime.get("requested_provider")
                             or runtime.get("provider")),
    }


def openai_transport_controls(base_url: str, provider: str | None = None) -> dict:
    from hermes_cli.runtime_provider_custom import route_transport_controls
    controls = route_transport_controls(base_url, provider)
    return {key: controls[key] for key in ("proxy_url", "proxy_fallback_to_direct") if key in controls}


def native_provider_http_client(provider: str, base_url: str):
    """Sync httpx client for a native-protocol provider client (e.g. ``GeminiNativeClient``) that
    honours ``providers.<id>.proxy_url`` / ``proxy_fallback_to_direct``, or ``None`` when the entry
    sets neither. Reads the raw entry: such a provider declares no ``base_url`` (the registered
    plugin owns the endpoint), so ``openai_transport_controls`` cannot match it by endpoint."""
    from hermes_cli.config import load_config
    entry = (load_config().get("providers") or {}).get(provider)
    if not isinstance(entry, dict):
        return None
    controls = {}
    if isinstance(entry.get("proxy_url"), str):
        controls["proxy_url"] = entry["proxy_url"]
    if isinstance(entry.get("proxy_fallback_to_direct"), bool):
        controls["proxy_fallback_to_direct"] = entry["proxy_fallback_to_direct"]
    if not controls:
        return None
    from agent.auxiliary_client import _resolve_aux_verify
    from agent.process_bootstrap import build_keepalive_http_client
    return build_keepalive_http_client(base_url, verify=_resolve_aux_verify(base_url), **controls)


def live_agent_controls(runtime: dict) -> dict:
    from hermes_cli.runtime_provider_custom import route_transport_controls
    identity = runtime_agent_controls(runtime)["timeout_provider"]
    controls = route_transport_controls(runtime.get("base_url", ""), identity)
    return {"timeout_provider": identity, "provider_streaming": controls.get("streaming")}


def route_policy_fingerprint(provider: str, base_url: str = "", model: str = "") -> tuple:
    """Live config identity for cached clients, without keys/headers/proxy credentials."""
    import hashlib
    from hermes_cli.config import get_compatible_custom_providers, load_config
    from hermes_cli.timeouts import get_provider_request_timeout, get_provider_stale_timeout

    identity = str(provider or "").strip().lower().removeprefix("custom:")
    target = str(base_url or "").strip().rstrip("/")
    entries = get_compatible_custom_providers(load_config())
    candidates = [entry for entry in entries if (
        (identity in {str(entry.get("provider_key") or "").lower(), str(entry.get("name") or "").lower()}
         if identity else bool(target) and str(entry.get("base_url") or "").rstrip("/") == target)
        and (not target or str(entry.get("base_url") or "").rstrip("/") == target)
    )]
    entry = candidates[0] if len(candidates) == 1 else {}
    proxy = entry.get("proxy_url")
    return (
        hashlib.sha256(proxy.encode()).hexdigest() if isinstance(proxy, str) else None,
        entry.get("proxy_fallback_to_direct"), entry.get("stream", entry.get("streaming")),
        get_provider_request_timeout(identity, model), get_provider_stale_timeout(identity, model),
    )
