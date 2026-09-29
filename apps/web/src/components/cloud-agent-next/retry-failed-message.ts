import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';

type FailureRecovery = {
  markMessageSuperseded(messageId: string, ownerSessionId: KiloSessionId): void;
  unmarkMessageSuperseded(messageId: string, ownerSessionId: KiloSessionId): void;
  clearFailedMessage(messageId: string, ownerSessionId?: KiloSessionId): void;
};

export async function retryFailedMessage(input: {
  messageId: string;
  ownerSessionId: KiloSessionId;
  recovery: FailureRecovery;
  /**
   * Re-sends the prompt. The callback fires once the re-send's own row is in
   * the transcript, which is the moment the original stops rendering.
   */
  send: (onOptimisticSend: () => void) => Promise<boolean>;
}): Promise<boolean> {
  const { messageId, ownerSessionId, recovery, send } = input;
  // The original is superseded in the same tap as the retry: waiting for the
  // transport round-trip would render the prompt twice for its duration.
  let accepted: boolean;
  try {
    accepted = await send(() => recovery.markMessageSuperseded(messageId, ownerSessionId));
  } catch (error) {
    // A throw delivers nothing, so the original must come back with its retry
    // control rather than stay hidden with no way to recover.
    recovery.unmarkMessageSuperseded(messageId, ownerSessionId);
    throw error;
  }
  if (!accepted) {
    recovery.unmarkMessageSuperseded(messageId, ownerSessionId);
    return false;
  }
  // Records the resolution against the owning session, so a replayed
  // `cloud.message.failed` cannot bring the row back on the next open.
  recovery.clearFailedMessage(messageId, ownerSessionId);
  return true;
}
