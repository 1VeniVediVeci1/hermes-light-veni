"""The classic connection panel reviews updates without claiming a live reload."""

from unittest.mock import Mock

import pytest

from agent.i18n import t
from hermes_cli.cli_modal_mixin import CLIModalMixin


@pytest.fixture
def panel():
    cli = CLIModalMixin()
    cli._paint_now = Mock()
    cli._connection_sync_input_buffer = Mock()
    cli._connection_send = Mock()
    return cli


def show(panel, state="pending"):
    target = {
        "name": "ghidra",
        "kind": "mcp",
        "action": "update",
        "state": state,
        "instructions": "command: [redacted]; existing sessions are unchanged",
    }
    panel._connection_show_target({"op_id": "update-op", "targets": [target]}, 0)
    return target


@pytest.mark.parametrize("status", ["approved", "skipped"])
def test_update_waits_for_consent_and_retries_through_normal_answer(panel, monkeypatch, status):
    apply = panel._connection_send
    show(panel)
    assert panel._connection_state["phase"] == "form"
    assert t("cli.connect.button_update") in "\n".join(panel._connection_render_lines())
    assert "command: [redacted]" in "\n".join(panel._connection_render_lines())
    apply.assert_not_called()

    panel._connection_state["selected"] = 0 if status == "approved" else 1
    panel._connection_submit()
    assert apply.call_args.args[:2] == ("connection_respond", "update-op")
    answer = apply.call_args.args[2]["targets"][0]
    assert answer["status"] == status
    assert answer["name"] == "ghidra"

    if status == "approved":
        show(panel, "failed")
        panel._connection_submit()
        assert apply.call_count == 2
        assert apply.call_args.args[2]["targets"][0]["status"] == "approved"


def test_updated_is_terminal_without_skip_retry_or_connected_claim(panel):
    target = show(panel)
    target = {**target, "state": "updated", "configuration_updated": True, "reload_required": True}
    panel._connection_on_change({"op_id": "update-op", "targets": [target]})
    assert panel._connection_state["phase"] == "updated"
    assert t("cli.connect.updated") in panel._connection_render_lines()
    assert t("cli.connect.connected") not in panel._connection_render_lines()
    panel._connection_send.reset_mock()
    panel._connection_retry()
    panel._connection_cancel()
    panel._connection_send.assert_not_called()
    assert panel._connection_opening_phase(target) == "updated"
