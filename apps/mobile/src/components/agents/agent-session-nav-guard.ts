import { type Href } from 'expo-router';

import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { type AgentSessionPushRouterLike } from '@/components/agents/session-router-like';

/**
 * Guard window for agent navigation. Two taps inside this window would push
 * the destination route twice, so the second tap is dropped. The window can be
 * generous because every caller also clears the state when its screen regains
 * focus, so a tap after a return is never dropped.
 */
export const AGENT_SESSION_NAV_GUARD_MS = 1000;

/** Mutable guard state. Each screen keeps one instance in a ref. */
export type AgentSessionNavGuardState = {
  /** `Date.now()` of the last accepted push. `0` means no push yet. */
  lastPushAt: number;
};

/**
 * Claim the single-push window: `true` when the caller may push once, `false`
 * when this call is the second of a double tap. Writes `lastPushAt` before
 * returning, so a re-entrant call cannot claim the same window twice.
 *
 * Three or more entry-point families (session rows, composer buttons, payload
 * staging entries) need this same lockstep rule.
 */
export function claimAgentPush(state: AgentSessionNavGuardState, now: number): boolean {
  if (now - state.lastPushAt < AGENT_SESSION_NAV_GUARD_MS) {
    return false;
  }
  state.lastPushAt = now;
  return true;
}

/**
 * Push `href`, unless a push was accepted less than
 * `AGENT_SESSION_NAV_GUARD_MS` ago. Returns `true` when it pushed.
 *
 * This is the shared core of every composer and session entry point: the
 * destination differs, the double-press rule does not.
 */
export function pushAgentHrefOnce(params: {
  state: AgentSessionNavGuardState;
  router: AgentSessionPushRouterLike;
  now: number;
  href: Href;
}): boolean {
  const { state, router, now, href } = params;
  if (!claimAgentPush(state, now)) {
    return false;
  }
  router.push(href);
  return true;
}

/**
 * Push the agent-chat route for one session, unless a push was accepted less
 * than `AGENT_SESSION_NAV_GUARD_MS` ago. Returns `true` when it pushed.
 */
export function pushAgentSessionOnce(params: {
  state: AgentSessionNavGuardState;
  router: AgentSessionPushRouterLike;
  now: number;
  sessionId: string;
  organizationId?: string | null;
  /** Title already on screen; seeds the destination header's first frame. */
  title?: string;
}): boolean {
  const { state, router, now, sessionId, organizationId, title } = params;
  return pushAgentHrefOnce({
    state,
    router,
    now,
    href: getAgentSessionPath(sessionId, organizationId ?? undefined, title),
  });
}
