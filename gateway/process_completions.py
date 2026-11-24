"""Gateway admission/dequeue of typed background process completion batches.

A shadow in the existing FIFO survives finalization and compression races. Only
process-owned shadows coalesce or disappear; human events are never classified by text.
"""
from __future__ import annotations

from agent.process_completions import ProcessCompletionBatch, ProcessCompletionInbox, format_internal_process_results


def process_batch_for_event(event):
    if not getattr(event, "internal", False):
        return None
    batch = getattr(event, "_process_completion_batch", None)
    if not isinstance(batch, ProcessCompletionBatch):
        records = (getattr(event, "metadata", None) or {}).get("process_completion_events")
        if isinstance(records, list) and records:
            batch = build_process_batch(records)
            if batch is not None:
                setattr(event, "_process_completion_batch", batch)
    return batch if isinstance(batch, ProcessCompletionBatch) else None


def build_process_batch(events):
    """Legacy receipts lacking exact ownership retain their existing idle-only path."""
    if not events:
        return None
    first = events[0]
    fields = ("session_key", "parent_session_id", "owner_task_id", "process_home")
    if not all(first.get(k) for k in fields) or first.get("started_at") is None:
        return None
    batch = ProcessCompletionBatch(*(first[k] for k in fields))
    batch.add(events)
    from tools.process_registry import process_registry
    process_registry.retain_completion_events(batch.snapshot())
    return batch


def refresh_process_event(event, *, session_key=None, parent_session_id=None):
    batch = process_batch_for_event(event)
    if batch is None:
        return True
    if session_key is not None and batch.session_key != session_key:
        return False
    if parent_session_id is not None and batch.parent_session_id != parent_session_id:
        return False
    from tools.process_registry import process_registry
    events = batch.unread(process_registry)
    if not events:
        return False
    event.text = format_internal_process_results(events)
    event.metadata["process_completion_events"] = batch.snapshot()
    # Failures are actionable results, not optional presentation diagnostics.
    if any(e.get("exit_code") not in (0, None) or e.get("completion_reason") != "exited" for e in events):
        event.metadata.pop("notification_category", None)
    return True


def route_busy_process_event(runner, event, session_key):
    """Return True on silent acceptance. Never call steer, interrupt, yield or kill."""
    batch = process_batch_for_event(event)
    if batch is None:
        return False
    if not refresh_process_event(event, session_key=session_key):
        event._gateway_accepted = True  # stale work was intentionally suppressed
        return True
    adapter = runner._delivery_adapter_for(event.source)
    if adapter is None or not hasattr(adapter, "_pending_messages"):
        return False
    candidates = [getattr(adapter, "_pending_messages", {}).get(session_key)]
    candidates.extend(runner._overflow_queue(session_key) or [])
    for pending in candidates:
        previous = process_batch_for_event(pending)
        if previous is not None and previous.route == batch.route:
            previous.add(batch.snapshot())
            batch = previous
            event._process_completion_batch = batch
            break
    else:
        runner._enqueue_fifo(session_key, event, adapter)
    state = runner._peek_session_state(session_key)
    agent = state.turn.agent if state else None
    # A setup/finalizing sentinel has no inbox. The shadow alone remains eligible
    # for the idle path; no polling or special resumption instruction is needed.
    if agent is not None and batch.targets_session(
            str(getattr(agent, "session_id", "") or ""), getattr(agent, "_session_db", None)):
        inbox = getattr(agent, "_process_completion_inbox", None)
        if inbox is None:
            inbox = agent._process_completion_inbox = ProcessCompletionInbox()
        inbox.add(batch)
    event._gateway_accepted = True
    return True


def prune_pending_process_events(runner, session_key, adapter, pending_event):
    """At dequeue, drop only stale process shadows, retaining all human FIFO entries."""
    overflow = runner._overflow_queue(session_key)
    pending_slot = getattr(adapter, "_pending_messages", {}) if adapter is not None else {}
    # At this seam the adapter may already have staged the next overflow head.
    staged = pending_slot.get(session_key)
    if staged is not None and not refresh_process_event(staged, session_key=session_key):
        pending_slot.pop(session_key, None)
    if overflow is not None:
        overflow[:] = [e for e in overflow if refresh_process_event(e, session_key=session_key)]
    while pending_event is not None and not refresh_process_event(pending_event, session_key=session_key):
        pending_event = pending_slot.pop(session_key, None)
        if pending_event is None and overflow:
            pending_event = overflow.pop(0)
    # Real human input has higher priority than a notification, without deleting,
    # merging or reordering humans relative to one another.
    if process_batch_for_event(pending_event) is not None:
        staged = pending_slot.get(session_key)
        if staged is not None and not getattr(staged, "internal", False):
            pending_slot[session_key] = pending_event
            pending_event = staged
        elif overflow:
            for i, candidate in enumerate(overflow):
                if not getattr(candidate, "internal", False):
                    overflow[i] = pending_event
                    pending_event = candidate
                    break
    return pending_event


def has_pending_process_shadow(runner, event, adapter):
    """A stop/slot-release can discard adapter state; a live watcher must then re-admit unread work."""
    sid, epoch = event.get("session_id"), event.get("started_at")
    key = event.get("session_key", "")
    state = runner._peek_session_state(key)
    candidates = [getattr(adapter, "_pending_messages", {}).get(key)]
    candidates.extend(runner._overflow_queue(key) or [])
    if state is not None:
        agent = state.turn.agent
        if not getattr(agent, "_interrupt_requested", False):
            candidates.append(getattr(state.turn, "event", None))
            inbox = getattr(agent, "_process_completion_inbox", None)
            if inbox is not None:
                with inbox._lock:
                    for batch in inbox._batches:
                        if any(e.get("session_id") == sid and e.get("started_at") == epoch for e in batch.snapshot()):
                            return True
    for candidate in candidates:
        batch = process_batch_for_event(candidate)
        if batch is not None and any(e.get("session_id") == sid and e.get("started_at") == epoch for e in batch.snapshot()):
            return True
    return False


def claim_idle_process_batch(batch, *, session_key, parent_session_id, session_db=None):
    from tools.process_registry import process_registry
    import uuid
    token = "idle:" + uuid.uuid4().hex
    from agent.estop import is_engaged
    if is_engaged():
        return token, []
    claimed = batch.claim(process_registry, session_key=session_key,
                          parent_session_id=parent_session_id, owner_task_id=parent_session_id,
                          claim_id=token, session_db=session_db)
    return token, claimed
