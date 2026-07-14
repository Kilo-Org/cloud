import {
  presenceContextForAgentSession,
  presenceContextForPlatform,
} from '@kilocode/event-service';
import {
  sendCloudAgentSessionNotificationInputSchema,
  sendSessionAttentionNotificationInputSchema,
  sendSessionReadyNotificationInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendCloudAgentSessionNotificationParams,
  type SendCloudAgentSessionNotificationResult,
  type SendSessionAttentionNotificationParams,
  type SendSessionAttentionNotificationResult,
  type SendSessionReadyNotificationParams,
  type SendSessionReadyNotificationResult,
  type SessionAttentionReason,
} from '@kilocode/notifications';

type CloudAgentNotificationSession = {
  title: string | null;
  organizationId: string | null;
};

export type DispatchCloudAgentSessionPushDeps = {
  getSession: (
    userId: string,
    cliSessionId: string
  ) => Promise<CloudAgentNotificationSession | null>;
  hasOrganizationAccess: (userId: string, organizationId: string) => Promise<boolean>;
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
};

type SessionPushContent = {
  presenceContext: string | null;
  idempotencyKey: string;
  title: string;
  body: string;
};

/**
 * Resolve the session for `cliSessionId` and confirm the caller still has
 * current organization membership if the session belongs to an org. Returns
 * `null` when the session is absent or access has been revoked, which the
 * callers translate into a terminal `missing_session` result.
 */
async function loadOwnedSession(
  userId: string,
  cliSessionId: string,
  deps: DispatchCloudAgentSessionPushDeps
): Promise<CloudAgentNotificationSession | null> {
  const session = await deps.getSession(userId, cliSessionId);
  if (!session) return null;
  if (
    session.organizationId &&
    !(await deps.hasOrganizationAccess(userId, session.organizationId))
  ) {
    return null;
  }
  return session;
}

async function dispatchSessionPush(
  userId: string,
  cliSessionId: string,
  buildContent: (session: CloudAgentNotificationSession) => SessionPushContent,
  deps: DispatchCloudAgentSessionPushDeps
): Promise<SendCloudAgentSessionNotificationResult> {
  const session = await loadOwnedSession(userId, cliSessionId, deps);
  if (!session) {
    return { dispatched: false, reason: 'missing_session' };
  }

  const content = buildContent(session);
  const outcome = await deps.dispatchPush({
    userId,
    presenceContext: content.presenceContext,
    idempotencyKey: content.idempotencyKey,
    badge: null,
    push: {
      title: content.title,
      body: content.body,
      data: { type: 'cloud_agent_session', cliSessionId },
      sound: 'default',
      priority: 'high',
    },
  } satisfies DispatchPushInput);

  if (outcome.kind === 'failed') {
    return { dispatched: false, reason: 'dispatch_failed' };
  }

  return { dispatched: true };
}

export async function dispatchCloudAgentSessionPush(
  params: SendCloudAgentSessionNotificationParams,
  deps: DispatchCloudAgentSessionPushDeps
): Promise<SendCloudAgentSessionNotificationResult> {
  const parsed = sendCloudAgentSessionNotificationInputSchema.parse(params);
  return dispatchSessionPush(
    parsed.userId,
    parsed.cliSessionId,
    session => ({
      presenceContext: null,
      idempotencyKey: `cloud-agent:${parsed.cliSessionId}:${parsed.executionId}`,
      title: session.title ?? 'Agent session',
      body: parsed.body,
    }),
    deps
  );
}

/**
 * Push sent when a CLI session first registers with session-ingest, telling
 * the user they can take over the session from their phone. Suppressed while
 * the user is actively in the mobile app (they already see the session list).
 */
export async function dispatchSessionReadyPush(
  params: SendSessionReadyNotificationParams,
  deps: DispatchCloudAgentSessionPushDeps
): Promise<SendSessionReadyNotificationResult> {
  const parsed = sendSessionReadyNotificationInputSchema.parse(params);
  return dispatchSessionPush(
    parsed.userId,
    parsed.cliSessionId,
    () => ({
      presenceContext: presenceContextForPlatform('app'),
      idempotencyKey: `cloud-agent:${parsed.cliSessionId}:session-ready`,
      title: 'Kilo session ready',
      body: 'Your Kilo session is ready to control from your phone',
    }),
    deps
  );
}

// ── Session attention (actionable human waits) ──────────────────────

/**
 * Fixed, lock-screen-safe copy per attention reason. Producers must never
 * supply a body or title — the notifications service rejects caller-provided
 * text to keep pushes safe.
 */
const SESSION_ATTENTION_COPY: Record<SessionAttentionReason, { title: string; body: string }> = {
  question: {
    title: 'Kilo session needs your input',
    body: 'Your Kilo session is asking a question',
  },
  permission: {
    title: 'Kilo session needs permission',
    body: 'Your Kilo session is waiting for permission to continue',
  },
  blocking_suggestion: {
    title: 'Kilo session needs a decision',
    body: 'Your Kilo session has a suggestion that needs your review',
  },
  action_required: {
    title: 'Kilo session needs you',
    body: 'Your Kilo session is waiting for you to take action',
  },
};

export type DispatchSessionAttentionPushDeps = DispatchCloudAgentSessionPushDeps;

/**
 * Notification sent when a Cloud Agent / remote CLI session hits a
 * human-actionable wait (question, permission, blocking suggestion, or
 * other action-required state). The presence context is the exact session,
 * so the push is suppressed only when the user is actively viewing that
 * session — not the whole app. The idempotency key includes the stable
 * requestId so retries on the same upstream request collapse, but distinct
 * requests stay independent.
 */
export async function dispatchSessionAttentionPush(
  params: SendSessionAttentionNotificationParams,
  deps: DispatchSessionAttentionPushDeps
): Promise<SendSessionAttentionNotificationResult> {
  const parsed = sendSessionAttentionNotificationInputSchema.parse(params);
  const copy = SESSION_ATTENTION_COPY[parsed.reason];
  const session = await loadOwnedSession(parsed.userId, parsed.cliSessionId, deps);
  if (!session) {
    return { dispatched: false, reason: 'missing_session' };
  }

  const outcome = await deps.dispatchPush({
    userId: parsed.userId,
    presenceContext: presenceContextForAgentSession(parsed.cliSessionId),
    idempotencyKey: `cloud-agent:${parsed.cliSessionId}:attention:${parsed.reason}:${parsed.requestId}`,
    badge: null,
    push: {
      title: copy.title,
      body: copy.body,
      data: { type: 'cloud_agent_session', cliSessionId: parsed.cliSessionId },
      sound: 'default',
      priority: 'high',
    },
  } satisfies DispatchPushInput);

  if (outcome.kind === 'suppressed_presence') {
    return { dispatched: false, reason: 'suppressed_presence' };
  }
  if (outcome.kind === 'failed') {
    return { dispatched: false, reason: 'dispatch_failed' };
  }

  return { dispatched: true };
}
