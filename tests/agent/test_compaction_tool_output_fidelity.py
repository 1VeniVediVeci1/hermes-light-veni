"""Compaction keeps tool output readable: tail pressure priced like the wire, summarizer reads source bodies.

Regression for receipts-only compaction: an agentic turn whose assistant rows carry large stale reasoning
kept the pressure pass over its soft ceiling (it charged thinking the route never re-sends), so every tail
tool result became ``ran `cmd` -> exit 0, N lines output``; the summarizer then also read those receipts,
so the handoff carried no results and the model re-ran its own calls.
"""

from __future__ import annotations

import json
from unittest.mock import patch

from agent.context_compressor import ContextCompressor
from agent.model_metadata import estimate_messages_tokens_rough


def _compressor() -> ContextCompressor:
    with patch("agent.context_compressor.get_model_context_length", return_value=1_000_000):
        c = ContextCompressor(
            model="test/model", threshold_percent=0.25, protect_first_n=3, protect_last_n=20,
            quiet_mode=True, config_context_length=1_000_000,
        )
    return c


def _round(i: int, reasoning_chars: int, body_lines: int = 40) -> list[dict]:
    output = "\n".join(f"probe-{i} row {j}: gain={j * 0.1:.1f} dB status=OK" for j in range(body_lines))
    return [
        {
            "role": "assistant", "content": None, "reasoning": "r" * reasoning_chars,
            "tool_calls": [{"id": f"c{i}", "type": "function",
                            "function": {"name": "terminal", "arguments": json.dumps({"command": f"probe {i}"})}}],
        },
        {"role": "tool", "tool_call_id": f"c{i}", "content": json.dumps({"output": output, "exit_code": 0})},
    ]


def _agentic_turn(rounds: int, reasoning_chars: int) -> list[dict]:
    msgs: list[dict] = [{"role": "system", "content": "You are Hermes."}, {"role": "user", "content": "Probe the board."}]
    for i in range(rounds):
        msgs += _round(i, reasoning_chars)
    return msgs


def test_stale_reasoning_does_not_demote_every_tail_tool_result():
    c = _compressor()
    msgs = _agentic_turn(rounds=24, reasoning_chars=20_000)
    out, _ = c._prune_old_tool_results(msgs, protect_tail_count=c.protect_last_n, protect_tail_tokens=c.tail_token_budget)
    boundary = c._prune_boundary([m.copy() for m in msgs], c.protect_last_n, c.tail_token_budget)
    tail = [i for i in range(boundary, len(msgs)) if msgs[i].get("role") == "tool"]
    assert len(tail) > 3, "fixture must put several rounds in the protected tail"
    kept = [i for i in tail if out[i]["content"] == msgs[i]["content"]]
    assert kept == tail, f"tail tool results demoted to receipts: {len(tail) - len(kept)} of {len(tail)}"


def test_native_anthropic_pressure_demotion_stops_once_under_ceiling():
    """The native route prices the whole list once; demotions must be re-priced, not read from a stale list."""
    msgs = [{"role": "system", "content": "You are Hermes."}, {"role": "user", "content": "Probe the board."}]
    for i in range(40):
        msgs += _round(i, reasoning_chars=0, body_lines=400)

    def _demoted(native: bool) -> int:
        c = _compressor()
        c.api_mode = "anthropic_messages" if native else "chat_completions"
        result = [m.copy() for m in msgs]
        call_ids = {tc["id"]: (tc["function"]["name"], tc["function"]["arguments"])
                    for m in msgs for tc in m.get("tool_calls") or []}
        with patch("agent.anthropic_thinking_policy.native_anthropic_preserves_prior_thinking", return_value=True):
            return c._pressure_demote_tail(
                result, 2, c.tail_token_budget, call_ids, min_prune_chars=200, spared=range(0))

    plain, native = _demoted(False), _demoted(True)
    assert 0 < plain < 38, "fixture must need some, not all, demotions"
    assert native == plain


def test_summarizer_reads_original_tool_bodies_not_prune_receipts():
    c = _compressor()
    seen: list[list[dict]] = []

    def _summary(turns, **_kwargs):
        seen.append(turns)
        return "summary"

    c._generate_summary = _summary
    msgs = _agentic_turn(rounds=60, reasoning_chars=200)
    msgs.append({"role": "assistant", "content": "Done probing."})
    msgs.append({"role": "user", "content": "Now compare the gains."})
    c.compress(list(msgs), current_tokens=estimate_messages_tokens_rough(msgs) + c.threshold_tokens)

    assert seen, "expected a summary call"
    originals = {m["tool_call_id"]: m["content"] for m in msgs if m.get("role") == "tool"}
    window_tools = [m for m in seen[0] if m.get("role") == "tool"]
    assert window_tools, "expected tool results in the summarized window"
    for m in window_tools:
        assert m["content"] == originals[m["tool_call_id"]], f"summarizer got a receipt: {m['content'][:100]!r}"
