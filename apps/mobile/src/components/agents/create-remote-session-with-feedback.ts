import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

/**
 * Run `createRemoteSession()` and surface exactly one actionable toast when it
 * fails. The success result carries the new session ID so the caller can
 * navigate after creation in a follow-up slice; the failure result is a stable
 * boolean that lets the composer preserve its draft without adding a second
 * toast.
 */
export async function createRemoteSessionWithFeedback(
  create: () => Promise<KiloSessionId>,
  onError: (message: string) => void
): Promise<{ success: true; sessionId: KiloSessionId } | { success: false }> {
  try {
    const sessionId = await create();
    return { success: true, sessionId };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : i18n.t('agentChat.remoteSession.failedToCreate');
    onError(message);
    return { success: false };
  }
}
