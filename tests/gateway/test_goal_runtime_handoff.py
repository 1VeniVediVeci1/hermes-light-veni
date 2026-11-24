from types import SimpleNamespace

import pytest


def test_goal_runtime_snapshot_is_generation_scoped_and_consumed_once():
    from gateway.run_goals import _consume_goal_main_runtime_snapshot, _remember_goal_main_runtime_snapshot

    runner = SimpleNamespace()
    agent = SimpleNamespace(provider="provider-a", model="model-a", base_url="https://example.invalid", api_key="secret", api_mode="chat")
    _remember_goal_main_runtime_snapshot(runner, "session-a", 3, agent)

    assert _consume_goal_main_runtime_snapshot(runner, "session-a", 2) is None
    runtime = _consume_goal_main_runtime_snapshot(runner, "session-a", 3)
    assert runtime["provider"] == "provider-a"
    assert _consume_goal_main_runtime_snapshot(runner, "session-a", 3) is None


@pytest.mark.asyncio
async def test_generation_bound_runtime_reaches_goal_judge_for_its_own_route():
    """The post-turn judge receives the runtime of the agent that executed that generation."""
    from gateway.run_goals import GatewayGoalsMixin, _consume_goal_main_runtime_snapshot, _remember_goal_main_runtime_snapshot

    class Manager:
        def __init__(self):
            self.seen = []

        def is_active(self):
            return True

        def evaluate_after_turn(self, _response, **kwargs):
            self.seen.append(kwargs["main_runtime"])
            return {"message": "", "should_continue": False, "continuation_prompt": ""}

    class Runner(GatewayGoalsMixin):
        async def _post_turn_manager(self, *_args):
            return manager

        async def _run_in_executor_with_context(self, fn):
            return fn()

        async def _defer_goal_status_notice_after_delivery(self, *_args):
            raise AssertionError("empty decision must not produce a notice")

    runner, manager = Runner(), Manager()
    route_a = SimpleNamespace(provider="route-a", model="model-a", base_url="https://a.invalid", api_mode="chat")
    route_b = SimpleNamespace(provider="route-b", model="model-b", base_url="https://b.invalid", api_mode="chat")
    _remember_goal_main_runtime_snapshot(runner, "key-a", 11, route_a)
    _remember_goal_main_runtime_snapshot(runner, "key-b", 12, route_b)
    entry = SimpleNamespace(session_id="goal-session")
    for key, generation in (("key-b", 12), ("key-a", 11)):
        runtime = _consume_goal_main_runtime_snapshot(runner, key, generation)
        await runner._post_turn_goal_continuation(
            session_entry=entry, source=None, final_response="finished", main_runtime=runtime,
        )
    assert [runtime["provider"] for runtime in manager.seen] == ["route-b", "route-a"]
