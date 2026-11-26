import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import { withTimeout } from '@/lib/with-timeout'
import { $backgroundRunningSessionIds } from '@/store/composer-status'
import { $gateway, activeGatewayProfileKey, gatewayRouteState, isActivePrimary, primaryRosterBatchRoute } from '@/store/gateway'
import { $primaryGatewayRoute } from '@/store/gateway-primary-route'
import { $liveWorkRoster, rosterSourceHasWork, setLiveWorkRosterSource } from '@/store/live-work-roster'
import { $gatewayState, ownerLookupSessionRows } from '@/store/session'
import { $delegatingSessionIds } from '@/store/session-dot-state'
import { ambientRequestFor } from '@/store/session-gone-latch'
import { isSessionOwnerRoute, requestForSessionProfile, type SessionOwnerScope } from '@/store/session-request-router'
import { knownOwnerForSession } from '@/store/session-states'

const POLL_MS = 10_000
// A closed socket whose last read showed work is re-dialed this often, not every tick.
const COLD_BUSY_MS = 60_000
// Window focus re-reads every source at most this often (alt-tab bursts).
const FOCUS_MIN_GAP_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
// Do not hold any read behind a slow capability hello / route lookup.
const BATCH_PLAN_MS = 1_000
const MAX_BATCH_PROFILES = 64

interface RosterResult {
  sessions?: unknown[]
}

type RosterBatchResult = { results?: (RosterResult & { error?: unknown })[] }
type RosterRead = [key: string, source: RosterSource]

interface RosterSource {
  /** Stored ids of the rows this source answers for. */
  covers: string[]
  open: boolean
  owner: SessionOwnerScope
}

const routeOf = (owner: SessionOwnerScope) =>
  isSessionOwnerRoute(owner)
    ? gatewayRouteState(owner.connectionId, owner.profile)
    : gatewayRouteState(null, String(owner ?? ''))

/** Every backend the sidebar shows rows for (recents, cron and messaging rows
 *  alike), keyed by the socket a read would ride, so one backend is asked once
 *  however many spellings its owner has (the launch profile used to be asked
 *  three times a tick). The ambient socket answers for the active profile; a row owned by another profile (or connection) is asked on
 *  the route its own session RPCs take, so each backend only reports
 *  conversations stored in that profile. */
function rosterSources(gateway: NonNullable<ReturnType<typeof $gateway.get>>): Map<string, RosterSource> {
  const primary = isActivePrimary()
  // The ambient read carries no profile. It shares a bucket only with the
  // primary's own profile or with the exact active secondary socket.
  const ambientKey = primary ? gatewayRouteState(null, activeGatewayProfileKey()).key : 'ambient'
  const sources = new Map<string, RosterSource>([[ambientKey, { covers: [], open: true, owner: undefined }]])

  // One row list per tick, each owner resolved against its own row: resolving
  // through the whole list per row made a tick O(rows²).
  for (const row of ownerLookupSessionRows()) {
    const owner = knownOwnerForSession(row.id, [row])

    if (!owner) {
      continue
    }

    const route = routeOf(owner)
    const key = !primary && route.gateway === gateway ? ambientKey : route.key
    const source = sources.get(key)

    if (source) {
      source.covers.push(row.id)
    } else {
      sources.set(key, { covers: [row.id], open: route.open, owner })
    }
  }

  return sources
}

/** App-level hydration of `$liveWorkRoster` (sidebar rows not on screen, and
 *  every row after a reload / socket reconnect): one read on each socket on
 *  connect and window focus, then every 10 s while visible. Multiplexed profiles
 *  batch when the socket advertised support; dedicated sockets stay independent.
 *  Interval ticks are passive: after a source's first read on this connection
 *  they read only sockets already open, plus a closed one whose last read showed
 *  work once a minute (so finished work clears without re-dialing every tick).
 *  A backend without the RPC stops; any other failure backs off and retries. */
export function useLiveWorkRoster() {
  const gateway = useStore($gateway)
  const gatewayState = useStore($gatewayState)
  // Route keys (`primary:<profile>`, `ambient`) name a socket, not a backend:
  // a soft re-home of the primary must start over, even while the foreground
  // socket (a secondary) stays open, or old buckets and stops outlive it.
  const { connectionId: primaryConnection, mode: primaryMode } = useStore($primaryGatewayRoute)

  useEffect(() => {
    // Counts from a dropped socket or a previous primary are unverified; the
    // (re)connect re-reads them.
    $liveWorkRoster.set({})

    if (gatewayState !== 'open' || !gateway) {
      return
    }

    const ambient = ambientRequestFor(gateway)
    let cancelled = false
    let lastHydrate = -Infinity
    let current = new Set<string>()
    const inFlight = new Set<string>()
    const unsupported = new Set<string>()
    const incompatibleBatch = new WeakSet<Promise<boolean>>()
    // Rows that load after the connect get their first read on the next tick.
    const sentAt = new Map<string, number>()
    const backoff = new Map<string, { failures: number; until: number }>()

    const failed = (key: string, error: unknown) => {
      if (isMissingRpcMethod(error)) {
        unsupported.add(key)
      } else {
        const failures = (backoff.get(key)?.failures ?? 0) + 1
        backoff.set(key, { failures, until: Date.now() + Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS) })
      }

      if (!cancelled && current.has(key)) {
        setLiveWorkRosterSource(key, null)
      }
    }

    const publish = ([key, { covers }]: RosterRead, result: RosterResult, at: number) => {
      backoff.delete(key)

      // A source whose rows left the sidebar mid-read stays pruned.
      if (!cancelled && current.has(key)) {
        setLiveWorkRosterSource(key, Array.isArray(result?.sessions) ? result.sessions : [], at, covers)
      }
    }

    const readSource = async (read: RosterRead) => {
      const [key, { owner }] = read

      try {
        if (!cancelled && current.has(key)) {
          const at = Date.now()
          sentAt.set(key, at)
          const result = await requestForSessionProfile<RosterResult>(owner, ambient, 'subagent.roster', {}, POLL_MS)
          publish(read, result, at)
        }
      } catch (error) {
        failed(key, error)
      } finally {
        inFlight.delete(key)
      }
    }

    const readSources = async (reads: RosterRead[]) => {
      const route = primaryRosterBatchRoute()
      const capability = route?.gateway.subagentRosterBatch

      if (!route || !capability || incompatibleBatch.has(capability)) {
        reads.forEach(read => void readSource(read))

        return
      }

      const candidates = reads.filter(read => {
        const { owner } = read[1]

        const eligible = owner === undefined ? gateway === route.gateway :
          route.mayShare(isSessionOwnerRoute(owner) ? owner.connectionId : null)

        if (!eligible) {
          void readSource(read)
        }

        return eligible
      })

      if (candidates.length < 2 || candidates.length > MAX_BATCH_PROFILES) {
        candidates.forEach(read => void readSource(read))

        return
      }

      let planExpired = false

      const selectors = await withTimeout(capability.then(supported => {
        if (!supported || cancelled || planExpired || route.gateway.subagentRosterBatch !== capability) {
          return []
        }

        return Promise.all(candidates.map(([, { owner }]) => {
          if (owner === undefined) {
            return { profile: null }
          }

          const [connectionId, profile] = isSessionOwnerRoute(owner)
            ? [owner.connectionId, owner.profile] as const : [null, String(owner)] as const

          return route.selector(connectionId, profile).catch(() => null)
        }))
      }), BATCH_PLAN_MS, 'Roster batch route not ready', () => { planExpired = true }).catch(() => [])

      const batch = candidates.flatMap((read, i) => {
        const selector = selectors[i]

        return selector && current.has(read[0]) ? [{ read, profile: selector.profile }] : []
      })

      const routeStillCurrent = () => route.isCurrent() && route.gateway.subagentRosterBatch === capability

      if (cancelled || batch.length < 2 || !routeStillCurrent()) {
        candidates.forEach(read => void readSource(read))

        return
      }

      const batched = new Set(batch.map(({ read }) => read))
      candidates.filter(read => !batched.has(read)).forEach(read => void readSource(read))
      const at = Date.now()
      batch.forEach(({ read: [key] }) => sentAt.set(key, at))
      let fallback = false

      try {
        const profiles = batch.map(({ profile }) => profile)
        const result = await route.gateway.request<RosterBatchResult>('subagent.roster', { profiles }, POLL_MS)

        if (!routeStillCurrent()) {
          return
        }

        const rows = result?.results

        if (!Array.isArray(rows) || rows.length !== batch.length) {
          fallback = true

          return
        }

        batch.forEach(({ read }, i) => {
          const item = rows[i]

          if (!Array.isArray(item?.sessions) || item.error) {
            failed(read[0], item?.error)
          } else {
            publish(read, item, at)
          }
        })
      } catch (error) {
        if (routeStillCurrent()) {
          batch.forEach(({ read: [key] }) => failed(key, error))
        }
      } finally {
        if (fallback) {
          incompatibleBatch.add(capability)
          batch.forEach(({ read }) => void readSource(read))
        } else {
          batch.forEach(({ read: [key] }) => inFlight.delete(key))
        }
      }
    }

    const refresh = (hydrate: boolean) => {
      if (cancelled) {
        return
      }

      const sources = rosterSources(gateway)
      const roster = $liveWorkRoster.get()
      const now = Date.now()
      // Rows lit right now: a closed source covering one is re-read on the busy
      // cadence even when its last read was empty, so work an event feed saw
      // start after that read still gets its end confirmed.
      const lit = new Set([...$backgroundRunningSessionIds.get(), ...$delegatingSessionIds.get()])
      current = new Set(sources.keys())

      // Owners whose rows left the sidebar stop contributing.
      for (const key of Object.keys(roster)) {
        if (!current.has(key)) {
          setLiveWorkRosterSource(key, null)
        }
      }

      const reads: RosterRead[] = []

      for (const [key, source] of sources) {
        const last = sentAt.get(key)
        const due = !inFlight.has(key) && !unsupported.has(key) && now >= (backoff.get(key)?.until ?? 0)

        const warm =
          hydrate ||
          source.open ||
          last === undefined ||
          ((rosterSourceHasWork(roster, key) || source.covers.some(id => lit.has(id))) && now - last >= COLD_BUSY_MS)

        if (due && warm) {
          inFlight.add(key)
          reads.push([key, source])
        }
      }

      if (reads.length) {
        void readSources(reads)
      }
    }

    const hydrate = () => {
      if (Date.now() - lastHydrate >= FOCUS_MIN_GAP_MS) {
        lastHydrate = Date.now()
        refresh(true)
      }
    }

    hydrate()

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh(false)
      }
    }, POLL_MS)

    window.addEventListener('focus', hydrate)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', hydrate)
    }
  }, [gateway, gatewayState, primaryConnection, primaryMode])
}
