import { z } from 'zod';

export type AttentionSignalKind = 'completed' | 'needs_input' | 'agent_notification';

export type AttentionSignal =
  | {
      signalId: string;
      kind: 'completed' | 'needs_input';
      /** Push-ready excerpt: whitespace-collapsed and capped to fit a notification body. */
      messageExcerpt: string;
    }
  | {
      kind: 'agent_notification';
      /** Stable id from the ingested `agent_notification` item's `data.id`. */
      notificationId: string;
      /** Full message body (1–500 chars) — not the 100-char `messageExcerpt` cap. */
      message: string;
    };

const NEEDS_INPUT_STATUSES = new Set(['question', 'permission']);

/** Statuses that mean the session is waiting for the user to answer a question or approve a permission. */
export function isNeedsInputStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && NEEDS_INPUT_STATUSES.has(status);
}

/**
 * The root session went idle — the assistant finished its turn and is awaiting the next user message.
 * Child-session statuses never reach this point: the kilo global feed drops any event whose
 * `sessionID` is not the root session's, so only root idle transitions are ingested.
 */
export function isCompletedStatus(status: string | null | undefined): boolean {
  return status === 'idle';
}

const CompletedAssistantMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal('assistant'),
  time: z.object({ completed: z.number() }),
});

/**
 * Returns the message id when a message item's stored `item_data` JSON is a completed assistant
 * message (role `assistant` with `time.completed`). Used to pair an idle transition with the
 * assistant turn that just finished, so the `completed` signal can carry that turn's excerpt.
 */
export function completedAssistantMessageIdFromItemData(itemDataJson: string): string | undefined {
  try {
    const parsed = CompletedAssistantMessageSchema.safeParse(JSON.parse(itemDataJson));
    return parsed.success ? parsed.data.id : undefined;
  } catch {
    return undefined;
  }
}

const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() });

/** Extracts the text of a `part` item's stored `item_data` JSON, or undefined if it isn't a text part. */
export function extractTextFromPartItemData(itemDataJson: string): string | undefined {
  try {
    const parsed = TextPartSchema.safeParse(JSON.parse(itemDataJson));
    return parsed.success ? parsed.data.text : undefined;
  } catch {
    return undefined;
  }
}

// Expo/APNs reject oversized push payloads outright, so the excerpt must stay far below
// that limit. Matches the snippet length cloud-agent-next uses for the same notification.
const EXCERPT_MAX_LENGTH = 100;
const ELLIPSIS = '...';

function truncateExcerpt(text: string): string {
  const singleLine = text.trim().replace(/\s+/g, ' ');
  if (singleLine.length <= EXCERPT_MAX_LENGTH) return singleLine;
  return singleLine.slice(0, EXCERPT_MAX_LENGTH - ELLIPSIS.length) + ELLIPSIS;
}

/** Joins text parts (already in emission order) into a single push-ready excerpt. */
export function buildAssistantExcerpt(partItemDataJsonRows: string[]): string {
  const pieces: string[] = [];
  for (const itemDataJson of partItemDataJsonRows) {
    const text = extractTextFromPartItemData(itemDataJson);
    if (text) pieces.push(text);
  }
  return truncateExcerpt(pieces.join(''));
}
