import { type Href } from 'expo-router';

import { type AgentSessionRouterLike } from '@/components/agents/session-router-like';

/**
 * Build the canonical agent-chat detail `Href` for a session, preserving the
 * organization context when the source route was org-scoped. The route is
 * keyed by `session-id` in `apps/mobile/src/app/(app)/agent-chat/[session-id].tsx`,
 * and the provider at that route re-keys on the `organizationId` so the new
 * session's manager picks up the right org context.
 */
export function getAgentSessionPath(kiloSessionId: string, organizationId?: string): Href {
  return organizationId
    ? (`/(app)/agent-chat/${kiloSessionId}?organizationId=${organizationId}` as Href)
    : (`/(app)/agent-chat/${kiloSessionId}` as Href);
}

/**
 * Replace the current route with the canonical agent-chat detail for the new
 * session. Using `replace` (not `push`) means the previous session route is
 * not on the stack, so the system back gesture does not return to it. The
 * route-keyed `AgentSessionProvider` recreates the manager for the new id, so
 * the caller does not switch the current manager before navigation.
 */
export function replaceWithAgentSession(
  router: AgentSessionRouterLike,
  kiloSessionId: string,
  organizationId?: string
): void {
  router.replace(getAgentSessionPath(kiloSessionId, organizationId));
}

/**
 * `Href` for the agent-chat detail when the parent route just spawned a
 * remote `kilo remote` session. Appends `?spawned=1` to whatever
 * `getAgentSessionPath` returns so the destination route can poll for
 * the freshly-ingested session row with a short retry window — the
 * parent's `Session.Event.Created` -> `IngestQueue` write is not
 * synchronous with the mobile query's read, so the route needs to
 * tolerate the transient NOT_FOUND that may show up before the row
 * is queryable.
 *
 * The `spawned=1` suffix is intentionally append-only: it never
 * replaces an existing query string. The optional `?organizationId=`
 * already produced by `getAgentSessionPath` is preserved and `spawned=1`
 * is joined with `&` in that case.
 */
export function getSpawnedAgentSessionPath(kiloSessionId: string, organizationId?: string): Href {
  // `getAgentSessionPath` returns an `Href` (= `string | HrefObject`)
  // but in this codebase every construction site uses the string
  // branch. Narrow with `as string` so the `.includes('?')` check
  // type-checks without forcing the helper to special-case
  // HrefObject (which the rest of the app does not use).
  const base = getAgentSessionPath(kiloSessionId, organizationId) as string;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}spawned=1` as Href;
}
