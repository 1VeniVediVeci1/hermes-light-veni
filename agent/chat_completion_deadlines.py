"""Finite absolute caps for Responses SSE, independent of event activity."""

import math
import time


def responses_total_timeout(agent, stale_timeout: float, *, explicit: bool, local: bool) -> float:
    """Keep healthy progress off the implicit stale wall, never off an absolute cap.

    Hosted streams retain the existing 1500s ceiling. Local explicit stale budgets
    retain their longer grace unless an operator sets a hard ceiling. Disabling the
    legacy hard knob does not make the new healthy-stream handoff unbounded.
    The run's *remaining* budget wins even over explicit stale settings and floors.
    """
    from agent.chat_completion_helpers import env_float, _local_stream_stale_timeout_default

    hard = env_float("HERMES_CODEX_HARD_TIMEOUT_SECONDS", 0.0)
    ceiling = hard if math.isfinite(hard) and hard > 0 else 1500.0
    if local and hard <= 0 and math.isfinite(stale_timeout):
        ceiling = max(ceiling, stale_timeout, _local_stream_stale_timeout_default())
    total = min(stale_timeout, ceiling) if explicit else ceiling
    budget = getattr(agent, "run_budget_seconds", None)
    started = getattr(agent, "_run_budget_started_at", None)
    if (isinstance(budget, (int, float)) and not isinstance(budget, bool) and budget > 0
            and isinstance(started, (int, float)) and not isinstance(started, bool)):
        total = min(total, max(0.0, budget - (time.time() - started)))
    return total
