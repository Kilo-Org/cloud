import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { type AgentSessionPushRouterLike } from '@/components/agents/session-router-like';

/**
 * Guard window for session-row navigation. Two taps on a session row inside
 * this window would push the agent-chat route twice, so the second tap is
 * dropped. The window can be generous because the caller also clears the state
 * when its screen regains focus, so a tap after a return is never dropped.
 */
export const AGENT_SESSION_NAV_GUARD_MS = 1000;

/** Mutable guard state. Each screen keeps one instance in a ref. */
export type AgentSessionNavGuardState = {
  /** `Date.now()` of the last accepted push. `0` means no push yet. */
  lastPushAt: number;
};

/**
 * Push the agent-chat route for one session, unless a push was accepted less
 * than `AGENT_SESSION_NAV_GUARD_MS` ago. Returns `true` when it pushed.
 * `state.lastPushAt` is written before the push, so a re-entrant call during
 * the push cannot push a second time.
 */
export function pushAgentSessionOnce(params: {
  state: AgentSessionNavGuardState;
  router: AgentSessionPushRouterLike;
  now: number;
  sessionId: string;
  organizationId?: string | null;
}): boolean {
  const { state, router, now, sessionId, organizationId } = params;
  if (now - state.lastPushAt < AGENT_SESSION_NAV_GUARD_MS) {
    return false;
  }
  state.lastPushAt = now;
  router.push(getAgentSessionPath(sessionId, organizationId ?? undefined));
  return true;
}
