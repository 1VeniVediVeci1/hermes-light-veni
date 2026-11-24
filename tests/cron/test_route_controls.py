"""Cron construction uses the same logical-route controls as interactive agents."""

import pytest


@pytest.mark.parametrize("streaming", [None, False, True])
def test_cron_constructor_retains_route_identity_and_streaming(tmp_path, streaming):
    from cron.scheduler import _CronAgentSetup, _construct_cron_agent
    captured = {}
    def construct(**kwargs):
        captured.update(kwargs)
        return captured
    setup = _CronAgentSetup(model="route-test", max_iterations=17, runtime={
        "provider": "custom", "requested_provider": "route-name", "timeout_provider": "route-name",
        "streaming": streaming, "base_url": "https://relay.invalid/v1", "api_key": "test-key",
    })
    _construct_cron_agent(construct, {}, {}, setup, workdir=tmp_path, session_id="test", session_db=None)
    assert captured["provider_streaming"] is streaming
    assert captured["timeout_provider"] == "route-name"
    assert captured["max_iterations"] == 17
