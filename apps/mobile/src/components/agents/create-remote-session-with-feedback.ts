import { type KiloSessionId } from 'cloud-agent-sdk';

export const CREATE_REMOTE_SESSION_FALLBACK_MESSAGE = 'Failed to create remote session';

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
    const message = error instanceof Error ? error.message : CREATE_REMOTE_SESSION_FALLBACK_MESSAGE;
    onError(message);
    return { success: false };
  }
}
