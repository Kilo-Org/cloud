import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

type FailureRecovery = {
  markMessageSuperseded(messageId: string, ownerSessionId: KiloSessionId): void;
  unmarkMessageSuperseded(messageId: string, ownerSessionId: KiloSessionId): void;
  clearFailedMessage(messageId: string, ownerSessionId?: KiloSessionId): void;
};

/**
 * Split a failed row's text into a slash command when it names a known
 * command, mirroring the composer's submit-time recognition: a known command
 * re-sends through the command payload, while unknown slash-looking text
 * stays a plain prompt (the composer would send it as plain text too).
 */
export function parseFailedCommandRow(
  prompt: string,
  slashCommands: Pick<SlashCommand, 'trigger'>[]
): { command: string; args: string } | null {
  const match = /^\s*\/([\w.-]+)(?:\s+([\s\S]*))?\s*$/.exec(prompt);
  if (!match) return null;
  const trigger = match[1];
  if (trigger === undefined) return null;
  const known = slashCommands.some(command => command.trigger === trigger);
  if (!known) return null;
  const args = match[2]?.trim() ?? '';
  return { command: trigger, args };
}

export async function retryFailedMessage(input: {
  /** Every row the re-send replaces: the failed row first, then the answered prompt. */
  messageIds: readonly string[];
  ownerSessionId: KiloSessionId;
  recovery: FailureRecovery;
  /**
   * Re-sends the prompt. The callback fires once the re-send's own row is in
   * the transcript, which is the moment the original stops rendering.
   */
  send: (onOptimisticSend: () => void) => Promise<boolean>;
}): Promise<boolean> {
  const { messageIds, ownerSessionId, recovery, send } = input;
  // The originals are superseded in the same tap as the retry: waiting for the
  // transport round-trip would render the prompt twice for its duration.
  let accepted: boolean;
  try {
    accepted = await send(() => {
      for (const messageId of messageIds) {
        recovery.markMessageSuperseded(messageId, ownerSessionId);
      }
    });
  } catch (error) {
    // A throw delivers nothing, so the originals must come back with their retry
    // control rather than stay hidden with no way to recover.
    for (const messageId of messageIds) {
      recovery.unmarkMessageSuperseded(messageId, ownerSessionId);
    }
    throw error;
  }
  if (!accepted) {
    for (const messageId of messageIds) {
      recovery.unmarkMessageSuperseded(messageId, ownerSessionId);
    }
    return false;
  }
  // Records the resolution against the owning session, so a replayed
  // `cloud.message.failed` cannot bring the rows back on the next open.
  for (const messageId of messageIds) {
    recovery.clearFailedMessage(messageId, ownerSessionId);
  }
  return true;
}
