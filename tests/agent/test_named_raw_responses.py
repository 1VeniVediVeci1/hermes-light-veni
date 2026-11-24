"""Named Responses routes must expose the wire API when requested raw."""



def test_named_raw_responses_exposes_sdk_resource(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / "config.yaml").write_text(
        "providers:\n  relay:\n    base_url: https://relay.invalid/v1\n"
        "    api_key: test-key\n    api_mode: codex_responses\n"
    )
    from agent.auxiliary_client import resolve_provider_client, CodexAuxiliaryClient
    raw, _ = resolve_provider_client("relay", model="test", raw_codex=True)
    wrapped, _ = resolve_provider_client("relay", model="test", raw_codex=False)
    try:
        assert callable(getattr(getattr(raw, "responses", None), "create", None))
        assert isinstance(wrapped, CodexAuxiliaryClient)
    finally:
        raw.close()
        wrapped.close()


def test_raw_codex_does_not_bypass_explicit_anthropic_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "providers:\n  relay:\n    base_url: https://relay.invalid\n"
        "    api_key: test-key\n    api_mode: anthropic_messages\n"
    )
    from agent.auxiliary_client import resolve_provider_client, _to_async_client
    from agent.auxiliary_client import AnthropicAuxiliaryClient, AsyncAnthropicAuxiliaryClient
    client, model = resolve_provider_client("relay", model="test", raw_codex=True)
    try:
        assert isinstance(client, AnthropicAuxiliaryClient)
        async_client, _ = _to_async_client(client, model)
        assert isinstance(async_client, AsyncAnthropicAuxiliaryClient)
        assert not hasattr(client, "responses")
    finally:
        client.close()
