/**
 * Push dispatch for the agent-callable `notify_user` tool. The session's
 * title is resolved service-side (callers never supply it) and the same
 * `cloud_agent_session` push `data` shape is reused so the existing mobile
 * deep-link handler and E2E fixture work without changes.
 *
 * Rate limiting, presence suppression, and the push sink are all enforced
 * by the recipient NotificationChannelDO; this helper composes the dispatch
 * input from resolved session data and maps the DO outcome to the RPC
 * result. The preference gate is read here (fail-closed) before any DO
 * call is made.
 */
import { presenceContextForCliSession } from '@kilocode/event-service';
import {
  sendAgentSessionNotificationInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendAgentSessionNotificationParams,
  type SendAgentSessionNotificationResult,
} from '@kilocode/notifications';

import {
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  sanitizeTitle,
  type UserNotificationPreferences,
} from './cloud-agent-session-push';

export type { SendAgentSessionNotificationParams } from '@kilocode/notifications';

type AgentNotificationSession = {
  title: string | null;
  organizationId: string | null;
};

export type AgentNotificationSessionPushContent = {
  presenceContext: string;
  idempotencyKey: string;
  title: string;
  body: string;
  /**
   * The session's organization, so a tap can land the app in the context the
   * session belongs to. Absent for a Personal session (the session row has no
   * organization_id), which leaves the app on Personal.
   */
  organizationId?: string;
};

export function buildAgentSessionNotificationContent(
  params: SendAgentSessionNotificationParams,
  session: AgentNotificationSession
): AgentNotificationSessionPushContent {
  return {
    presenceContext: presenceContextForCliSession(params.cliSessionId),
    idempotencyKey: `agent-notification:${params.cliSessionId}:${params.notificationId}`,
    title: sanitizeTitle(session.title) ?? 'Agent session',
    body: params.message,
    ...(session.organizationId != null && { organizationId: session.organizationId }),
  };
}

export type DispatchAgentSessionNotificationPushDeps = {
  getSession: (userId: string, cliSessionId: string) => Promise<AgentNotificationSession | null>;
  hasOrganizationAccess: (userId: string, organizationId: string) => Promise<boolean>;
  /**
   * Read the user's notification preferences. The explicit `notify_user`
   * push is classified needs-input (see
   * `buildAgentSessionNotificationDispatchInput`), so it gates on
   * `agentAttentionEnabled`, the same 'Agent needs you' toggle the
   * attention producer of `cloud_agent_session` reads — not on
   * `agentPushEnabled` ('Agent updates'), which no longer governs it. A throw
   * fails closed (§4.5) and propagates as a
   * `{dispatched:false, reason:'failed'}` result; the RPC layer does not
   * translate that into a thrown RPC error because preference read is a
   * recoverable, fail-closed path, not a transport failure. `null` is a
   * successful read that returned no row — default-on for every category.
   */
  readPreferences: (userId: string) => Promise<UserNotificationPreferences | null>;
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
};

/**
 * Compose the dispatch input for an agent session notification. Exposed for
 * tests; the orchestrator uses the same fields internally.
 */
export function buildAgentSessionNotificationDispatchInput(
  params: SendAgentSessionNotificationParams,
  content: AgentNotificationSessionPushContent
): DispatchPushInput {
  return {
    userId: params.userId,
    presenceContext: content.presenceContext,
    idempotencyKey: content.idempotencyKey,
    badge: null,
    push: {
      title: content.title,
      body: content.body,
      // Session title and agent-authored message are user-authored; both pass
      // through the catalog templates as params.
      i18nKey: 'agentSession.notification',
      i18nParams: { sessionTitle: content.title, message: content.body },
      // The explicit `notify_user` tool call is a question for the user, so the
      // push is classified as needs-input (breaks through Do Not Disturb) rather
      // than falling back to the absent-category default of status.
      data: {
        type: 'cloud_agent_session',
        cliSessionId: params.cliSessionId,
        category: 'attention',
        // The session's organization rides on the push so a tap can switch the
        // app before it opens the session. Absent for a Personal session.
        ...(content.organizationId != null && { organizationId: content.organizationId }),
      },
      sound: 'default',
      priority: 'high',
    },
    rateLimit: {
      key: `agent:${params.cliSessionId}`,
      limit: 5,
      windowSeconds: 600,
    },
  } satisfies DispatchPushInput;
}

/**
 * Map a DO dispatch outcome to the pinned RPC result shape. Exported so
 * tests can assert the complete DO-outcome → RPC-result mapping (§5).
 */
export function mapAgentDispatchOutcomeToResult(
  outcome: DispatchPushOutcome
): SendAgentSessionNotificationResult {
  switch (outcome.kind) {
    case 'delivered':
      return { dispatched: true };
    case 'suppressed_presence':
    case 'suppressed_rate_limit':
    case 'no_tokens':
    case 'duplicate':
      return { dispatched: false, reason: outcome.kind };
    case 'failed':
      return { dispatched: false, reason: 'failed' };
  }
}

export async function dispatchAgentSessionNotificationPush(
  params: SendAgentSessionNotificationParams,
  deps: DispatchAgentSessionNotificationPushDeps
): Promise<SendAgentSessionNotificationResult> {
  const parsed = sendAgentSessionNotificationInputSchema.parse(params);
  const session = await deps.getSession(parsed.userId, parsed.cliSessionId);
  if (!session) {
    return { dispatched: false, reason: 'not_found' };
  }
  if (
    session.organizationId &&
    !(await deps.hasOrganizationAccess(parsed.userId, session.organizationId))
  ) {
    return { dispatched: false, reason: 'not_found' };
  }

  // Preference read fails closed per §4.5: a throw ⇒ no push.
  let prefs: UserNotificationPreferences;
  try {
    const row = await deps.readPreferences(parsed.userId);
    prefs = row ?? DEFAULT_USER_NOTIFICATION_PREFERENCES;
  } catch {
    return { dispatched: false, reason: 'failed' };
  }
  if (!prefs.agentAttentionEnabled) {
    return { dispatched: false, reason: 'suppressed_preference' };
  }

  const content = buildAgentSessionNotificationContent(parsed, session);
  const dispatchInput = buildAgentSessionNotificationDispatchInput(parsed, content);

  const outcome = await deps.dispatchPush(dispatchInput);
  return mapAgentDispatchOutcomeToResult(outcome);
}
