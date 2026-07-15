import type {
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '@kilocode/notifications';
import type { AttentionSignal } from './dos/session-ingest-attention';

export type RemoteSessionInfo = {
  parentSessionId: string | null;
};

/** Only root sessions can be eligible for attention pushes. */
export function isEligibleForRemoteSessionAttention(session: RemoteSessionInfo): boolean {
  return session.parentSessionId === null;
}

const NEEDS_INPUT_BODY = 'Kilo needs your input.';
const DEFAULT_COMPLETED_BODY = 'Task completed';

// Temporary until the CLI's session-presence reporting is released.
const REMOTE_SESSION_ATTENTION_PUSH_ENABLED = false;

export function buildRemoteSessionAttentionPushBody(
  signal: Pick<AttentionSignal, 'kind' | 'messageExcerpt'>
): string {
  if (signal.kind === 'needs_input') return NEEDS_INPUT_BODY;
  return signal.messageExcerpt.length > 0 ? signal.messageExcerpt : DEFAULT_COMPLETED_BODY;
}

export type DispatchRemoteSessionAttentionDeps = {
  hasActiveCliSession: () => Promise<boolean>;
  sendPush: (
    params: SendCloudAgentSessionNotificationParams
  ) => Promise<SendCloudAgentSessionNotificationResult>;
};

export type DispatchRemoteSessionAttentionOutcome = 'sent' | 'suppressed';

/**
 * Sends a best-effort mobile push for a remote session attention signal. Viewing suppression
 * is handled by the notifications service presence check. An active remote connection must
 * currently report the session in its heartbeat. Callers are expected to have already confirmed
 * `isEligibleForRemoteSessionAttention` for the owning session.
 */
export async function dispatchRemoteSessionAttentionSignal(
  params: { kiloUserId: string; sessionId: string; signal: AttentionSignal },
  deps: DispatchRemoteSessionAttentionDeps
): Promise<DispatchRemoteSessionAttentionOutcome> {
  if (!REMOTE_SESSION_ATTENTION_PUSH_ENABLED) {
    return 'suppressed';
  }

  if (!(await deps.hasActiveCliSession())) {
    return 'suppressed';
  }

  await deps.sendPush({
    userId: params.kiloUserId,
    cliSessionId: params.sessionId,
    executionId: `remote:${params.signal.signalId}`,
    // The push status enum has no needs_input value and the notifications service ignores
    // status when building the push — the body carries the real semantics. Extending the
    // enum would fail validation on a notifications worker deployed with the old schema.
    status: 'completed',
    body: buildRemoteSessionAttentionPushBody(params.signal),
    suppressIfViewingSession: true,
  });

  return 'sent';
}
