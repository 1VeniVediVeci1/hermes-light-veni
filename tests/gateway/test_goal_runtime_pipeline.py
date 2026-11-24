"""Actual inbound -> turn cleanup -> post hooks -> GoalManager -> auxiliary call seam."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


@pytest.mark.asyncio
async def test_interleaved_final_routes_reach_judge_once(tmp_path, monkeypatch, caplog):
    from gateway.run import GatewayRunner
    from gateway.config import GatewayConfig, Platform
    from gateway.session import SessionSource
    from gateway.platforms.event import MessageEvent, MessageType
    from gateway.run_turn import GatewayTurnMixin
    from hermes_cli.goals import GoalManager
    import agent.auxiliary_client as auxiliary

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / "sessions"))
    runner._draining = False
    managers = {key: GoalManager(session_id="sid-" + key) for key in ("a", "b")}
    for key, manager in managers.items():
        manager.set("complete bounded task " + key, max_turns=5)
    token = lambda: "must-not-evaluate-or-store"
    routes = {
        "a": SimpleNamespace(provider="custom", requested_provider="named-fallback-a", model="fallback-model-a",
                             base_url="https://a.invalid/v1", api_key=token, api_mode="chat_completions"),
        "b": SimpleNamespace(provider="custom", requested_provider="named-b", model="model-b",
                             base_url="https://b.invalid/v1", api_key="private-test-credential", api_mode="chat_completions"),
    }
    seen = []
    def fake_call_llm(**kwargs):
        seen.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"verdict":"continue","reason":"more work"}'))])
    monkeypatch.setattr(auxiliary, "call_llm", fake_call_llm)
    monkeypatch.setattr(runner, "_hm_admit_event", AsyncMock(side_effect=lambda e: (e, e.source, True)))
    monkeypatch.setattr(runner, "_hm_estop_gate", lambda *a: None)
    monkeypatch.setattr(runner, "_hm_pending_reply_intercepts", AsyncMock(return_value=None))
    monkeypatch.setattr(runner, "_hm_dispatch_idle_commands", AsyncMock(return_value=(False, None)))
    monkeypatch.setattr(runner, "_hm_evict_idle_stale_agent", lambda *a: None)
    monkeypatch.setattr(runner, "_persist_active_agents", lambda: None)
    monkeypatch.setattr(runner, "_clear_durable_active_turn", AsyncMock())
    monkeypatch.setattr(runner, "_defer_goal_status_notice_after_delivery", AsyncMock())
    monkeypatch.setattr(runner, "_post_turn_loop_completion", AsyncMock())
    monkeypatch.setattr(runner, "_session_key_for_source", lambda s: s.chat_id)
    monkeypatch.setattr(runner, "_goal_max_turns_from_config", lambda: 5)
    monkeypatch.setattr(runner, "_delivery_adapter_for", lambda s: None)
    monkeypatch.setattr(runner, "_post_turn_manager", AsyncMock(side_effect=lambda entry, *a: managers[entry.session_id[-1]]))
    monkeypatch.setattr(runner, "_run_in_executor_with_context", AsyncMock(side_effect=lambda fn: fn()))
    fake_store = SimpleNamespace(get_or_create_session=AsyncMock(
        side_effect=lambda source, **kw: SimpleNamespace(session_id="sid-" + source.chat_id)))
    monkeypatch.setattr(GatewayRunner, "async_session_store", property(lambda self: fake_store))
    entered = {key: asyncio.Event() for key in routes}
    release_a = asyncio.Event()
    async def execute(event, source, key, generation):
        entered[key].set()
        if key == "a":
            await release_a.wait()
        tracking = asyncio.create_task(asyncio.Event().wait())
        ctx = SimpleNamespace(session_key=key, run_generation=generation, agent_holder=[routes[key]],
                              stream_consumer_holder=[None], streaming_tts_consumer_holder=[None])
        await GatewayTurnMixin._run_agent_cleanup_turn_tasks(runner, ctx, progress_task=None, log_task=None,
            interrupt_monitor=None, _notify_task=None, tracking_task=tracking, stream_task=None)
        return {"final_response": "bounded result " + key}
    monkeypatch.setattr(runner, "_handle_message_with_agent", execute)
    def event(key):
        return MessageEvent(text="task", message_type=MessageType.TEXT, internal=True,
                            source=SessionSource(platform=Platform.TELEGRAM, chat_id=key, chat_type="dm"))
    try:
        a = asyncio.create_task(runner._handle_message(event("a")))
        await entered["a"].wait()
        await runner._handle_message(event("b"))
        release_a.set()
        await a
        assert [k["main_runtime"]["requested_provider"] for k in seen] == ["named-b", "named-fallback-a"]
        assert seen[1]["main_runtime"]["api_key"] is token
        assert all(k["task"] == "goal_judge" for k in seen)
        assert not getattr(runner, "_goal_main_runtime_snapshots", {})
        assert "private-test-credential" not in caplog.text
        assert "must-not-evaluate-or-store" not in caplog.text
        # GoalState is persisted by the actual manager; route credentials must never enter it.
        for manager in managers.values():
            assert "private-test-credential" not in str(vars(manager.state))
    finally:
        release_a.set()
        runner.session_store.close_all_db_handles()
        runner.close_all_session_db_handles()


def test_invalidated_generation_discards_snapshot():
    from gateway.run_goals import _remember_goal_main_runtime_snapshot, _consume_goal_main_runtime_snapshot
    runner = SimpleNamespace(_is_session_run_current=lambda key, generation: generation == 2)
    _remember_goal_main_runtime_snapshot(runner, "route", 1, SimpleNamespace(provider="old", model="m"))
    assert _consume_goal_main_runtime_snapshot(runner, "route", 1) is None
    assert not getattr(runner, "_goal_main_runtime_snapshots", {})
