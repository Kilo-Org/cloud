import type { MessageDeliveryState, StoredMessage, TextPart } from '@kilocode/cloud-agent-sdk';

export type FailedMessageRetryTarget = {
  /** The failed user row that an accepted re-send resolves. */
  messageId: string;
  /** The text the re-send submits as a new user turn. */
  prompt: string;
};

/**
 * The failed message that the error notice's Retry sends again, or null when
 * Retry is not available.
 *
 * Only the newest user row qualifies: a later message makes the earlier failure
 * stale. A user Stop is not a failure to retry. Only a row the server never
 * delivered qualifies: it is a client-side (synthetic) row, which an accepted
 * re-send deletes. A delivered row stays in history, so a re-send would show the
 * prompt twice. The re-send carries the prompt text alone, so a row with an
 * attachment or more than one text part is not offered, because a retry would
 * silently drop that content. A queued slash command renders as `/command args`
 * text, and a re-send would submit that text as a plain prompt, so a row whose
 * text starts with `/` is not offered either.
 */
export function failedMessageRetryTarget(
  messages: readonly StoredMessage[],
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>
): FailedMessageRetryTarget | null {
  const latestUserRow = messages.findLast(message => message.info.role === 'user');
  if (latestUserRow?.info.role !== 'user' || latestUserRow.info.synthetic !== true) return null;
  const delivery = pendingMessages.get(latestUserRow.info.id);
  if (delivery?.status !== 'failed' || delivery.reason === 'interrupted') return null;
  const prompt = onlyPromptText(latestUserRow);
  if (prompt === null || prompt.trimStart().startsWith('/')) return null;
  return { messageId: latestUserRow.info.id, prompt };
}

/**
 * The row's single human-authored text, or null when the row holds anything
 * else a text re-send would omit. Server routing context is transcript chrome,
 * not content. A queued row can carry its prompt as a synthetic part.
 */
function onlyPromptText(message: StoredMessage): string | null {
  const content = message.parts.filter(
    part => !(part.type === 'text' && (part.ignored === true || isCloudAgentContext(part)))
  );
  const [part, ...rest] = content;
  if (rest.length > 0 || part?.type !== 'text') return null;
  return part.text.trim() === '' ? null : part.text;
}

function isCloudAgentContext(part: TextPart): boolean {
  return part.synthetic === true && part.text.includes('<cloud-agent-context');
}
