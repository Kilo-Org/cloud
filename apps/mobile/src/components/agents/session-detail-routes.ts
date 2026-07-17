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
