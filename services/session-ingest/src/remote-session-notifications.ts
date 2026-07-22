import type {
  SendAgentSessionNotificationParams,
  SendAgentSessionNotificationResult,
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

/** Attention signals that carry the 100-char `messageExcerpt` (completed / needs_input). */
export type ExcerptAttentionSignal = Extract<
  AttentionSignal,
  { kind: 'completed' | 'needs_input' }
>;

export function buildRemoteSessionAttentionPushBody(signal: ExcerptAttentionSignal): string {
  if (signal.kind === 'needs_input') return NEEDS_INPUT_BODY;
  return signal.messageExcerpt.length > 0 ? signal.messageExcerpt : DEFAULT_COMPLETED_BODY;
}

export type DispatchRemoteSessionAttentionDeps = {
  remoteSessionAttentionPushUserId?: string;
  hasActiveCliSession: () => Promise<boolean>;
  sendPush: (
    params: SendCloudAgentSessionNotificationParams
  ) => Promise<SendCloudAgentSessionNotificationResult>;
  /**
   * RPC for the explicit `notify_user` tool path (§4.4, §4.10). Thrown transport/DO errors
   * must propagate so the caller's dispatch marker stays `pending` — the dedicated
   * branch below never catches.
   */
  sendAgentSessionNotification: (
    params: SendAgentSessionNotificationParams
  ) => Promise<SendAgentSessionNotificationResult>;
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
  // §4.3: `agent_notification` signals are an explicit `notify_user` tool call. The user
  // asked for the ping, and a headless `kilo run` may exit right after emitting it — neither
  // the per-user rollout gate nor the live-CLI gate must apply, or this single notification
  // the user explicitly requested would silently be lost. Root-session eligibility is still
  // enforced one level up by the caller, and presence-suppression is handled downstream by
  // the notifications service.
  if (params.signal.kind === 'agent_notification') {
    const result = await deps.sendAgentSessionNotification({
      userId: params.kiloUserId,
      cliSessionId: params.sessionId,
      notificationId: params.signal.notificationId,
      message: params.signal.message,
    });
    console.log({
      event: 'agent_push_outcome',
      cliSessionId: params.sessionId,
      notificationId: params.signal.notificationId,
      outcome: result.dispatched ? 'dispatched' : (result.reason ?? 'failed'),
    });
    return result.dispatched ? 'sent' : 'suppressed';
  }

  // Legacy attention pushes (completed / needs_input) remain gated behind the staged
  // per-user rollout and the live-CLI presence check.
  if (deps.remoteSessionAttentionPushUserId?.trim() !== params.kiloUserId) {
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
