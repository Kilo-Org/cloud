import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { createRemoteSessionWithFeedback } from '@/components/agents/create-remote-session-with-feedback';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { type AgentSessionRouterLike } from '@/components/agents/session-router-like';

type RestartAgentSessionInput = {
  create: () => Promise<KiloSessionId>;
  exit: () => Promise<void>;
  router: AgentSessionRouterLike;
  onError: (message: string) => void;
  organizationId?: string;
};

/**
 * `/clear` for a remote CLI session: end this session and open a new one on
 * the same screen.
 *
 * Order matters. `exit_cli` detaches the session, and the relay then rejects
 * a session-scoped `create_session` with SESSION_OWNER_CHANGED, so the new
 * session must exist before the old one is detached. The CLI attaches the new
 * session to the same host, so the later detach never takes the host down.
 *
 * - Create fails: one toast, no exit, no navigation. The composer keeps the
 *   draft, exactly like /new.
 * - Exit fails: the new session already exists, so navigate anyway and report
 *   that the old session stayed open. Retrying the exit after navigation is
 *   impossible — the old manager is gone — so there is no retry CTA.
 *
 * One generic message on exit failure is deliberate. The non-retryable exit
 * errors `exitRemoteSessionWithFeedback` classifies (upgrade-required,
 * exit-not-supported, exit-unavailable) cannot reach this catch: the composer
 * parser already rejects /clear with an upgrade message when the catalog does
 * not report `canExitSession: true`. What is left is a transport or ownership
 * failure, and its message is not actionable once the user is on a new
 * session. The actionable fact is the one this message states.
 */
export async function restartAgentSession({
  create,
  exit,
  router,
  onError,
  organizationId,
}: Readonly<RestartAgentSessionInput>): Promise<
  { success: true; sessionId: KiloSessionId } | { success: false }
> {
  const created = await createRemoteSessionWithFeedback(create, onError);
  if (!created.success) {
    return { success: false };
  }
  try {
    await exit();
  } catch {
    onError(i18n.t('agentChat.remoteSession.restartExitFailed'));
  }
  replaceWithAgentSession(router, created.sessionId, organizationId);
  return { success: true, sessionId: created.sessionId };
}
