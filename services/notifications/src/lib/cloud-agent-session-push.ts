import { presenceContextForCliSession, presenceContextForPlatform } from '@kilocode/event-service';
import {
  sendCloudAgentSessionNotificationInputSchema,
  sendSessionReadyNotificationInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendCloudAgentSessionNotificationParams,
  type SendCloudAgentSessionNotificationResult,
  type SendSessionReadyNotificationParams,
  type SendSessionReadyNotificationResult,
} from '@kilocode/notifications';

type CloudAgentNotificationSession = {
  title: string | null;
  organizationId: string | null;
};

const TITLE_MAX_LENGTH = 80;

export function sanitizeTitle(title: string | null | undefined): string | null {
  if (title == null) return null;
  const collapsed = title.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= TITLE_MAX_LENGTH) return collapsed;
  return `${codePoints.slice(0, TITLE_MAX_LENGTH - 3).join('')}...`;
}

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

async function dispatchSessionPush(
  userId: string,
  cliSessionId: string,
  buildContent: (session: CloudAgentNotificationSession) => SessionPushContent,
  deps: DispatchCloudAgentSessionPushDeps
): Promise<SendCloudAgentSessionNotificationResult> {
  const session = await deps.getSession(userId, cliSessionId);

  if (!session) {
    return { dispatched: false, reason: 'missing_session' };
  }

  if (
    session.organizationId &&
    !(await deps.hasOrganizationAccess(userId, session.organizationId))
  ) {
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
      presenceContext: parsed.suppressIfViewingSession
        ? presenceContextForCliSession(parsed.cliSessionId)
        : null,
      idempotencyKey: `cloud-agent:${parsed.cliSessionId}:${parsed.executionId}`,
      title: sanitizeTitle(session.title) ?? 'Agent session',
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
    session => ({
      presenceContext: presenceContextForPlatform('app'),
      idempotencyKey: `cloud-agent:${parsed.cliSessionId}:session-ready`,
      title:
        sanitizeTitle(parsed.title ?? null) ?? sanitizeTitle(session.title) ?? 'Kilo session ready',
      body: 'Your Kilo session is ready to control from your phone',
    }),
    deps
  );
}
