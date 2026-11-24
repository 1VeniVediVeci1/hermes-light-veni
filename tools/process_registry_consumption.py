"""Single-consumer ownership for process results (admission is not consumption)."""
from typing import Any
from hermes_constants import hermes_home_key


class CompletionConsumptionMixin:
    _lock: Any
    _running: dict
    _finished: dict
    _completion_consumed: set
    _completion_claims: dict
    _completion_pending_routes: dict

    @staticmethod
    def _route_of(event):
        return tuple(event.get(k) for k in (
            "started_at", "session_key", "parent_session_id", "owner_task_id", "process_home"))

    def _mark_completion_consumed(self, session_id):
        # wait/log/kill still return snapshots on an explicit reread. Their acknowledgement
        # wins over a pending automatic claim, so a failed automatic flush cannot refund it.
        with self._lock:
            self._completion_consumed.add(session_id)
            self._completion_claims[session_id] = "explicit"
            self._completion_pending_routes.pop(session_id, None)

    def _unread_completion_locked(self, event, *, session_key, parent_session_id, owner_task_id, home):
        sid = event.get("session_id")
        if sid in self._completion_consumed:
            return False
        session = self._running.get(sid) or self._finished.get(sid)
        route = self._completion_pending_routes.get(sid)
        if session is not None:
            if not session.exited:
                return False
            # A handed-off process records its new owner's session id as ``session_key``, not the
            # gateway route key the notice carries, so the claimant's key stands for it.
            route = (session.started_at, event.get("session_key") if session.handoff_note else session.session_key,
                     session.parent_session_id, session.owner_task_id or session.task_id, session.profile_home)
        return (event.get("type") == "completion"
                and bool(session_key) and bool(parent_session_id) and bool(owner_task_id)
                and route == (event.get("started_at"), session_key, parent_session_id, owner_task_id, home)
                and (event.get("session_key"), event.get("parent_session_id"),
                     event.get("owner_task_id"), event.get("process_home"))
                == (session_key, parent_session_id, owner_task_id, home))

    def retain_completion_events(self, events):
        """Retain only verified routing identities while an unread shadow waits past process TTL.

        Output remains in the bounded batch payload, not an unbounded ProcessSession pin.
        """
        with self._lock:
            for event in events:
                if self._unread_completion_locked(
                    event, session_key=event.get("session_key"),
                    parent_session_id=event.get("parent_session_id"),
                    owner_task_id=event.get("owner_task_id"), home=event.get("process_home"),
                ):
                    self._completion_pending_routes[event["session_id"]] = self._route_of(event)

    def unread_completion_events(self, events, *, session_key, parent_session_id, owner_task_id, process_home=None):
        home = process_home if process_home is not None else hermes_home_key()
        with self._lock:
            return [event for event in events if self._unread_completion_locked(
                event, session_key=session_key, parent_session_id=parent_session_id,
                owner_task_id=owner_task_id, home=home)]

    def claim_completion_events(self, events, *, session_key, parent_session_id, owner_task_id, claim_id):
        """Final check and ownership transfer under the SAME lock as explicit acknowledgement."""
        home = hermes_home_key()
        with self._lock:
            claimed = []
            for event in events:
                if self._unread_completion_locked(
                    event, session_key=session_key, parent_session_id=parent_session_id,
                    owner_task_id=owner_task_id, home=home,
                ):
                    sid = event["session_id"]
                    self._completion_consumed.add(sid)
                    self._completion_claims[sid] = claim_id
                    # Pin the identity until the canonical append/model-start path
                    # commits or refunds; registry TTL must not erase an in-flight owner.
                    self._completion_pending_routes[sid] = self._route_of(event)
                    claimed.append(event)
            return claimed

    def commit_completion_events(self, events, *, claim_id):
        with self._lock:
            for event in events:
                sid = event["session_id"]
                if self._completion_claims.get(sid) == claim_id:
                    self._completion_pending_routes.pop(sid, None)

    def release_completion_events(self, events, *, claim_id):
        """A failed canonical append/flush refunds only its own claim, never a later wait/log."""
        with self._lock:
            for event in events:
                sid = event["session_id"]
                if self._completion_claims.get(sid) == claim_id:
                    self._completion_claims.pop(sid, None)
                    self._completion_consumed.discard(sid)
                    self._completion_pending_routes[sid] = self._route_of(event)
