import { atom } from 'nanostores'

import type { HermesGateway } from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

const SLASH_COMPLETIONS_KEY = 'slash-completions'
const COMMAND_CATALOG_KEY = 'command-catalog'
const COMMAND_CATALOG_TTL_MS = 60_000
const gatewayIds = new WeakMap<HermesGateway, number>()
let nextGatewayId = 0

/** Draft catalogs have no session workspace. An attached session needs its own
 * key even in the same profile: trusted project skills are workspace-dependent. */
export function commandCatalogKey(gateway: HermesGateway, scope: string, sessionId?: string | null, cwd?: string | null) {
  let id = gatewayIds.get(gateway)

  if (id === undefined) {
    id = ++nextGatewayId
    gatewayIds.set(gateway, id)
  }

  return [COMMAND_CATALOG_KEY, id, gateway.catalogConnectionGeneration, scope, sessionId ?? null, cwd ?? null] as const
}

type CatalogKey = ReturnType<typeof commandCatalogKey>

// Do not shorten the existing session-scoped cache to optimize draft opens.
const catalogTtl = (key: CatalogKey) => key[4] ? SLASH_COMPLETIONS_TTL_MS : COMMAND_CATALOG_TTL_MS

export function cachedCommandCatalog<T>(key: CatalogKey, fetcher: () => Promise<T>): Promise<T> {
  return queryClient.fetchQuery({
    queryKey: key,
    queryFn: fetcher,
    staleTime: catalogTtl(key),
    gcTime: catalogTtl(key),
    retry: false
  })
}

export function hasCachedCommandCatalog(key: CatalogKey): boolean {
  const state = queryClient.getQueryState(key)

  return state?.data !== undefined && !state.isInvalidated && Date.now() - state.dataUpdatedAt < catalogTtl(key)
}

// Cache typed slash completions between keystrokes; mutations and skills.changed
// invalidate them. Draft catalogs use a shorter backstop for config/usage changes.
const SLASH_COMPLETIONS_TTL_MS = 60 * 60_000

/** Serve a `/` completion response from cache, fetching only when stale. */
export function cachedSlashCompletion<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  return queryClient.fetchQuery({
    queryKey: [SLASH_COMPLETIONS_KEY, key],
    queryFn: fetcher,
    gcTime: SLASH_COMPLETIONS_TTL_MS,
    staleTime: SLASH_COMPLETIONS_TTL_MS,
    // A completion is only worth having while the popover is open. Retrying a
    // failed lookup with backoff would spend seconds answering a keystroke the
    // user has already typed past; the caller falls back to an empty list and
    // the next keystroke asks again.
    retry: false
  })
}

/** True when `cachedSlashCompletion(key)` will resolve without a round trip. */
export function hasCachedSlashCompletion(key: string): boolean {
  const state = queryClient.getQueryState([SLASH_COMPLETIONS_KEY, key])

  return state?.data !== undefined && Date.now() - state.dataUpdatedAt < SLASH_COMPLETIONS_TTL_MS
}

// `@` path completions are a directory listing, which unlike the command
// catalog CAN change under the user (a build writes files, a branch switch
// rewrites a tree). They get the same de-duplication but a short TTL: long
// enough that walking back up a path you just walked down is instant, short
// enough that the listing never looks stale.
const PATH_COMPLETIONS_KEY = 'path-completions'
const PATH_COMPLETIONS_TTL_MS = 15_000

/** Serve an `@` path completion from cache, fetching only when stale. */
export function cachedPathCompletion<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  return queryClient.fetchQuery({
    queryKey: [PATH_COMPLETIONS_KEY, key],
    queryFn: fetcher,
    gcTime: PATH_COMPLETIONS_TTL_MS,
    staleTime: PATH_COMPLETIONS_TTL_MS,
    retry: false
  })
}

/** True when `cachedPathCompletion(key)` will resolve without a round trip. */
export function hasCachedPathCompletion(key: string): boolean {
  const state = queryClient.getQueryState([PATH_COMPLETIONS_KEY, key])

  return state?.data !== undefined && Date.now() - state.dataUpdatedAt < PATH_COMPLETIONS_TTL_MS
}

/**
 * Bumped on every invalidation. The composer's completion adapter de-dupes by
 * query, so an unchanged `/` would never re-ask on its own — it watches this
 * instead to know the answer it's holding is no longer current.
 */
export const $slashCompletionsEpoch = atom(0)

/**
 * Drop cached `/` completions. Called from every site that changes which
 * skills exist or are enabled — install/uninstall/update from the hub, a
 * skill toggle or delete in Capabilities — so the composer's list matches
 * the backend without waiting out the TTL.
 */
export function invalidateSlashCompletions(): void {
  // Remove pending catalogs too, so an answer from before the mutation
  // cannot refill the cache after this invalidation.
  queryClient.removeQueries({ queryKey: [COMMAND_CATALOG_KEY] })
  invalidateTypedSlashCompletions()
}

function invalidateTypedSlashCompletions(): void {
  void queryClient.invalidateQueries({ queryKey: [SLASH_COMPLETIONS_KEY] })
  $slashCompletionsEpoch.set($slashCompletionsEpoch.get() + 1)
}

// The catalog has an explicit connection/profile key. Typed completion
// keys still include ambient scopes, so clear them on profile switches.
let cachedProfile: null | string = null

$activeGatewayProfile.subscribe(value => {
  const key = normalizeProfileKey(value)

  if (cachedProfile !== null && cachedProfile !== key) {
    invalidateTypedSlashCompletions()
  }

  cachedProfile = key
})
