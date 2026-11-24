"""Configurable size cap for user attachments (local addition).

``attachments.max_bytes`` overrides every built-in attachment cap at once: the browser file and
image uploads, staged-upload redemption, inline ``file.attach`` data URLs and
``image.attach_bytes``. Unset/null keeps each route's own default; ``0`` removes the cap; a
positive integer replaces it. Read on every call, so a config edit applies to new uploads
without a restart. File previews and PDF page rendering are independently uncapped.
"""

from __future__ import annotations

from typing import Optional


def attachment_size_cap(default: int) -> Optional[int]:
    """The byte cap for one attachment: *default* unless configured; ``None`` means no cap."""
    from hermes_cli.config import load_config_readonly

    section = load_config_readonly().get("attachments")
    value = section.get("max_bytes") if isinstance(section, dict) else None
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("attachments.max_bytes must be null, 0 (no limit) or a positive integer")
    return value or None
