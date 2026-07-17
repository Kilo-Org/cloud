import { type KiloSessionId } from 'cloud-agent-sdk';

import { createRemoteSessionWithFeedback } from '@/components/agents/create-remote-session-with-feedback';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { type AgentSessionRouterLike } from '@/components/agents/session-router-like';

type CreateAndNavigateAgentSessionInput = {
  create: () => Promise<KiloSessionId>;
  router: AgentSessionRouterLike;
  onError: (message: string) => void;
  organizationId?: string;
};

/**
 * Orchestrate `manager.createRemoteSession()` with single-toast error feedback
 * and `router.replace` to the new session route on success.
 *
 * - On success: the new `KiloSessionId` is the canonical session route key;
 *   `router.replace` is invoked exactly once before we resolve, so the
 *   composer's "accepted" signal (and draft clear) only fires after
 *   navigation has been initiated. The route-keyed `AgentSessionProvider`
 *   creates a fresh manager for the new id — we never call
 *   `manager.switchSession` here.
 * - On failure: a single toast is surfaced through `onError` (using the
 *   underlying Error message, or a fallback for non-Error throws) and
 *   `router.replace` is never called, so the user stays on the current
 *   session with their draft preserved.
 */
export async function createAndNavigateAgentSession({
  create,
  router,
  onError,
  organizationId,
}: Readonly<CreateAndNavigateAgentSessionInput>): Promise<
  { success: true; sessionId: KiloSessionId } | { success: false }
> {
  const feedback = await createRemoteSessionWithFeedback(create, onError);
  if (!feedback.success) {
    return { success: false };
  }
  replaceWithAgentSession(router, feedback.sessionId, organizationId);
  return { success: true, sessionId: feedback.sessionId };
}
