import {
  sendCloudAgentSessionNotificationInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendCloudAgentSessionNotificationParams,
  type SendCloudAgentSessionNotificationResult,
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

export async function dispatchCloudAgentSessionPush(
  params: SendCloudAgentSessionNotificationParams,
  deps: DispatchCloudAgentSessionPushDeps
): Promise<SendCloudAgentSessionNotificationResult> {
  const parsed = sendCloudAgentSessionNotificationInputSchema.parse(params);
  const session = await deps.getSession(parsed.userId, parsed.cliSessionId);

  if (!session) {
    return { dispatched: false, reason: 'missing_session' };
  }

  if (
    session.organizationId &&
    !(await deps.hasOrganizationAccess(parsed.userId, session.organizationId))
  ) {
    return { dispatched: false, reason: 'missing_session' };
  }

  const outcome = await deps.dispatchPush({
    userId: parsed.userId,
    presenceContext: null,
    idempotencyKey: `cloud-agent:${parsed.cliSessionId}:${parsed.executionId}`,
    badge: null,
    push: {
      title: session.title ?? 'Agent session',
      body: parsed.body,
      data: { type: 'cloud_agent_session', cliSessionId: parsed.cliSessionId },
      sound: 'default',
      priority: 'high',
    },
  } satisfies DispatchPushInput);

  if (outcome.kind === 'failed') {
    return { dispatched: false, reason: 'dispatch_failed' };
  }

  return { dispatched: true };
}
