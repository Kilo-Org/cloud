import { presenceContextForCliSession, presenceContextForPlatform } from '@kilocode/event-service';
import {
  cloudAgentSessionCategorySchema,
  sendCloudAgentSessionNotificationInputSchema,
  sendSessionReadyNotificationInputSchema,
  type CloudAgentSessionCategory,
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

/** Per-category preference columns, shared with the rest of the notification pipeline. */
export type UserNotificationPreferences = {
  agentPushEnabled: boolean;
  chatMessagesEnabled: boolean;
  agentAttentionEnabled: boolean;
  sessionStatusEnabled: boolean;
  kiloclawActivityEnabled: boolean;
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
  /**
   * Read the user's notification preferences. A throw fails closed
   * (no push). `null` = successful read that returned no row, which is
   * default-on for every category.
   */
  readPreferences: (userId: string) => Promise<UserNotificationPreferences | null>;
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
};

type SessionPushContent = {
  presenceContext: string | null;
  idempotencyKey: string;
  title: string;
  body: string;
  category: CloudAgentSessionCategory;
};

async function dispatchSessionPush(
  userId: string,
  cliSessionId: string,
  buildContent: (session: CloudAgentNotificationSession) => SessionPushContent,
  preferenceColumn: (prefs: UserNotificationPreferences) => boolean,
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

  // Per-category preference gate. Fail-closed: a read throw is treated
  // as a transport-level failure and surfaced as `dispatch_failed` (the
  // existing failure reason on this RPC).
  let prefs: UserNotificationPreferences;
  try {
    const row = await deps.readPreferences(userId);
    prefs = row ?? {
      agentPushEnabled: true,
      chatMessagesEnabled: true,
      agentAttentionEnabled: true,
      sessionStatusEnabled: true,
      kiloclawActivityEnabled: true,
    };
  } catch {
    return { dispatched: false, reason: 'dispatch_failed' };
  }
  if (!preferenceColumn(prefs)) {
    return { dispatched: false, reason: 'suppressed_preference' };
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
      // ponytail: `category` is always set on the emitted pushData so the
      // mobile deep-link handler can dispatch on attention vs. status
      // without a second round-trip. The default covers the rolling-deploy
      // window in which old producers omit the `category` field.
      data: { type: 'cloud_agent_session', cliSessionId, category: content.category },
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
  // ponytail: Absent `category` is treated as 'status' at the read site
  // (the existing rolling-deploy default). Producers that omit it keep
  // being routed through `sessionStatusEnabled`.
  const category: CloudAgentSessionCategory = parsed.category ?? 'status';
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
      category,
    }),
    prefs => (category === 'attention' ? prefs.agentAttentionEnabled : prefs.sessionStatusEnabled),
    deps
  );
}

// Re-export so call sites that already imported the schema name continue
// to compile; no behavioural change.
export { cloudAgentSessionCategorySchema };

/**
 * Push sent when a CLI session first registers with session-ingest, telling
 * the user they can take over the session from their phone. Suppressed while
 * the user is actively in the mobile app (they already see the session list).
 *
 * Session-ready is always a status notification (the session is up; nothing
 * demands user attention), so it gates on `sessionStatusEnabled`.
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
      category: 'status',
    }),
    prefs => prefs.sessionStatusEnabled,
    deps
  );
}
