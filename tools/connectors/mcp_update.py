"""Narrow, profile-scoped updates of existing stdio MCP server configurations.

Probe a replacement before committing it; never stop an existing live connection.
The caller owns approval/cancellation and must serialize the final commit with it.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

UPDATE_PROPERTIES = {
    "command": {"type": "string", "minLength": 1},
    "args": {"type": "array", "items": {"type": "string"}},
    "timeout": {"type": "number", "exclusiveMinimum": 0},
    "connect_timeout": {"type": "number", "exclusiveMinimum": 0},
}
UPDATE_SCHEMA = {
    "type": "object", "minProperties": 1, "additionalProperties": False,
    "properties": UPDATE_PROPERTIES,
    "description": (
        "update only: fields to replace on exactly one configured stdio MCP server, including custom "
        "servers outside the catalog. Omitted settings, credentials and enabled state are preserved. "
        "args replaces the whole argument list (use [] to clear). Probe precedes save; existing live "
        "connections are not restarted. A successful result says updated, not connected."
    ),
}


def validate_updates(updates: Any) -> str | None:
    if not isinstance(updates, dict) or not updates:
        return "update requires a non-empty 'updates' object."
    if set(updates) - UPDATE_PROPERTIES.keys():
        return "updates supports only command, args, timeout and connect_timeout; credentials and transport are unchanged."
    for key, value in updates.items():
        if key == "command":
            if not isinstance(value, str) or not value.strip() or "\0" in value:
                return "updates.command must be a non-empty executable name/path without NUL characters."
        elif key == "args":
            if not isinstance(value, list) or not all(isinstance(v, str) and "\0" not in v for v in value):
                return "updates.args must be an array of strings without NUL characters."
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            return f"updates.{key} must be a finite positive number."
    return None


@dataclass(frozen=True)
class PreparedUpdate:
    name: str
    path: Path
    before: dict[str, Any]
    after: dict[str, Any]
    fields: tuple[str, ...]
    reload_required: bool


def _check_managed(name: str, fields: tuple[str, ...]) -> None:
    from hermes_cli import managed_scope

    if any(managed_scope.is_key_managed(f"mcp_servers.{name}.{key}") for key in fields):
        raise ValueError("MCP settings pinned by an administrator cannot be updated by this tool.")


def prepare_update(name: str, updates: dict[str, Any]) -> PreparedUpdate:
    from hermes_cli.config import get_config_path, require_readable_config_before_write
    from hermes_cli.mcp_config import _probe_single_server
    from hermes_cli.mcp_security import validate_mcp_server_entry
    from hermes_cli.web_routers._common import config_write_scope
    from tools.mcp_tool_common import mcp_server_enabled, write_mcp_server_enabled

    error = validate_updates(updates)
    if error:
        raise ValueError(error)
    fields = tuple(sorted(updates))
    _check_managed(name, fields)
    with config_write_scope(None):
        path = get_config_path()
        current = require_readable_config_before_write(path)
        servers = current.get("mcp_servers", {})
        before = copy.deepcopy(servers.get(name)) if isinstance(servers, dict) else None
    if not isinstance(before, dict) or not before.get("command") or before.get("url"):
        raise ValueError("update requires an existing stdio MCP server; it cannot add a server or change transport.")
    after = copy.deepcopy(before)
    after.update(copy.deepcopy(updates))
    if validate_mcp_server_entry(name, after):
        raise ValueError("Updated MCP launch rejected by the existing safety validator; configuration unchanged.")
    probe_config = copy.deepcopy(after)
    # A deliberately disabled server can be repaired without enabling it on disk.
    write_mcp_server_enabled(probe_config, True)
    try:
        _probe_single_server(name, probe_config)
    except Exception as exc:
        # Child stderr and exception messages can contain inherited credential values.
        raise ValueError(f"MCP update probe failed ({type(exc).__name__}); configuration unchanged.") from None
    return PreparedUpdate(name, path, before, after, fields, mcp_server_enabled(after))


def commit_update(prepared: PreparedUpdate) -> None:
    from hermes_cli.config import _CONFIG_LOCK, atomic_config_write, get_config_path, require_readable_config_before_write
    from hermes_cli.web_routers._common import config_write_scope

    # Web mutations and core config writers use distinct locks. Keep their usual
    # web-scope -> core-lock order across the entire read/compare/write interval.
    with config_write_scope(None), _CONFIG_LOCK:
        if get_config_path() != prepared.path:
            raise ValueError("MCP update profile changed; configuration was not written.")
        _check_managed(prepared.name, prepared.fields)
        current = require_readable_config_before_write(prepared.path)
        servers = current.get("mcp_servers", {})
        if not isinstance(servers, dict) or servers.get(prepared.name) != prepared.before:
            raise ValueError("MCP server configuration changed during the probe; retry with the current configuration.")
        # Re-read the full document so unrelated edits made during the probe survive.
        servers[prepared.name] = copy.deepcopy(prepared.after)
        atomic_config_write(prepared.path, current)
