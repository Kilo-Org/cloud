/**
 * Reconstructs a human-readable conversation transcript from a sequence of
 * AgentDO streaming events.
 *
 * The SDK emits a stream of fine-grained events as an agent works. This
 * utility reassembles those events into clean `{ role, content }` turns that
 * can be injected into a prompt for context recovery after a container restart.
 *
 * Event types consumed:
 *   - `message.updated` / `message.completed` — carries the final Message
 *     object (UserMessage | AssistantMessage) in `data.info`.
 *   - `message_part.updated` — carries a streaming Part in `data.part`;
 *     TextParts are accumulated per messageID so assistant text is captured
 *     even when no `message.updated` event follows (e.g. mid-stream crash).
 *
 * The returned transcript is ordered chronologically and truncated to
 * `maxTurns` (keeping the most recent turns).
 */

import { z } from 'zod';
import { type RigAgentEventRecord } from '../db/tables/rig-agent-events.table';

// ── Output type ────────────────────────────────────────────────────────────

export type ToolCallSummary = {
  tool: string;
  status: string;
  /** Truncated one-liner describing the call (e.g. "bash: git status → ok") */
  summary: string;
};

export type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls made during this assistant turn (empty for user turns). */
  toolCalls: ToolCallSummary[];
};

// ── Zod schemas for the event data payloads ────────────────────────────────
// We only validate the fields we actually use, using .passthrough() to ignore
// everything else. This makes the schemas resilient to schema evolution.

const UserMessageSummary = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
});

const UserMessageInfo = z
  .object({
    id: z.string(),
    role: z.literal('user'),
    // User text lives inside summary.body (generated later) or is not in the
    // message object at all — the raw prompt is only visible in part events.
    summary: UserMessageSummary.optional(),
  })
  .passthrough();

const AssistantMessageInfo = z
  .object({
    id: z.string(),
    role: z.literal('assistant'),
    error: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const MessageInfo = z.union([UserMessageInfo, AssistantMessageInfo]);

// Payload of message.updated / message.completed events
const MessageEventData = z
  .object({
    info: MessageInfo,
  })
  .passthrough();

// TextPart from message_part.updated
const TextPartData = z
  .object({
    id: z.string(),
    messageID: z.string(),
    type: z.literal('text'),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
  })
  .passthrough();

// ToolPart from message_part.updated — captures the tool name and execution state
// so we can summarize what the agent did (not just what it said).
const ToolStateData = z
  .object({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    title: z.string().optional(),
  })
  .passthrough();

const ToolPartData = z
  .object({
    id: z.string(),
    messageID: z.string(),
    type: z.literal('tool'),
    tool: z.string().optional(),
    state: ToolStateData.optional(),
  })
  .passthrough();

// Minimal Part schema — we care about TextPart and ToolPart; everything else
// is parsed as an unknown part so we can skip it gracefully.
const PartData = z.discriminatedUnion('type', [
  TextPartData,
  ToolPartData,
  z.object({ type: z.literal('reasoning'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('file'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('step-start'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('step-finish'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('snapshot'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('patch'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('agent'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('retry'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('compaction'), messageID: z.string() }).passthrough(),
  z.object({ type: z.literal('subtask'), messageID: z.string() }).passthrough(),
]);

// Payload of message_part.updated events
const PartEventData = z
  .object({
    part: PartData,
  })
  .passthrough();

// ── Internal state during reconstruction ──────────────────────────────────

type UserInfo = z.infer<typeof UserMessageInfo>;
type AssistantInfo = z.infer<typeof AssistantMessageInfo>;

type MessageAccumulator = {
  role: 'user' | 'assistant';
  // Latest snapshot of the message metadata (may be null if we only saw parts)
  info: UserInfo | AssistantInfo | null;
  // Text parts keyed by part id; stored in insertion order
  textParts: Map<string, string>;
  // Tool call summaries keyed by part id; stored in insertion order
  toolCalls: Map<string, ToolCallSummary>;
  // Whether this message had any non-text parts (tool calls, etc.)
  hasNonTextParts: boolean;
};

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Reconstruct a conversation transcript from a flat list of AgentDO events.
 *
 * @param events    Ordered sequence of `RigAgentEventRecord` rows from AgentDO.
 * @param maxTurns  Maximum number of turns to return. When the transcript
 *                  exceeds this, the oldest turns are dropped so the most
 *                  recent context is preserved. Pass `Infinity` to keep all.
 *                  Defaults to 50.
 *
 * @returns  Array of `{ role, content }` turns in chronological order.
 */
export function reconstructConversation(
  events: RigAgentEventRecord[],
  maxTurns = 50
): ConversationTurn[] {
  // messageId → accumulator, insertion-ordered
  const messages = new Map<string, MessageAccumulator>();

  for (const event of events) {
    const { event_type, data } = event;

    if (event_type === 'message.updated' || event_type === 'message.completed') {
      const parsed = MessageEventData.safeParse(data);
      if (!parsed.success) continue;

      const { info } = parsed.data;
      let acc = messages.get(info.id);
      if (!acc) {
        acc = {
          role: info.role,
          info,
          textParts: new Map(),
          toolCalls: new Map(),
          hasNonTextParts: false,
        };
        messages.set(info.id, acc);
      } else {
        // Update with the latest message metadata
        acc.info = info;
        acc.role = info.role;
      }
    } else if (event_type === 'message_part.updated' || event_type === 'message.part.updated') {
      // The SDK emits both forms depending on version; handle both.
      const parsed = PartEventData.safeParse(data);
      if (!parsed.success) continue;

      const { part } = parsed.data;
      const messageId = part.messageID;

      let acc = messages.get(messageId);
      if (!acc) {
        // We may see part events before the message.updated event — create a
        // placeholder accumulator. Role will be filled in when we see the info.
        acc = {
          role: 'assistant', // default; corrected when message info arrives
          info: null,
          textParts: new Map(),
          toolCalls: new Map(),
          hasNonTextParts: false,
        };
        messages.set(messageId, acc);
      }

      if (part.type === 'text') {
        // Skip synthetic / ignored parts (used for internal context injection)
        if (part.synthetic || part.ignored) continue;
        acc.textParts.set(part.id, part.text);
      } else if (part.type === 'tool') {
        acc.hasNonTextParts = true;
        acc.toolCalls.set(part.id, summarizeToolCall(part));
      } else {
        acc.hasNonTextParts = true;
      }
    }
  }

  // ── Assemble turns ───────────────────────────────────────────────────────

  const turns: ConversationTurn[] = [];

  for (const acc of messages.values()) {
    const content = buildContent(acc);
    if (content === null) continue; // skip empty turns
    const toolCalls = [...acc.toolCalls.values()];
    turns.push({ role: acc.role, content, toolCalls });
  }

  // ── Truncate ─────────────────────────────────────────────────────────────

  if (turns.length > maxTurns) {
    return turns.slice(turns.length - maxTurns);
  }

  return turns;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildContent(acc: MessageAccumulator): string | null {
  if (acc.role === 'user') {
    return buildUserContent(acc);
  }
  return buildAssistantContent(acc);
}

function buildUserContent(acc: MessageAccumulator): string | null {
  // User messages: text parts hold the raw prompt text.
  // If no text parts are present, fall back to summary.body if available.
  const fromParts = joinTextParts(acc.textParts);
  if (fromParts !== '') return fromParts;

  const summaryBody = extractSummaryBody(acc.info);
  if (summaryBody) return summaryBody;

  // No text content found — user turn is unreadable (e.g. file-only message)
  return null;
}

function buildAssistantContent(acc: MessageAccumulator): string | null {
  const fromParts = joinTextParts(acc.textParts);
  if (fromParts !== '') return fromParts;

  // Tool-only turns: include them if we captured tool call summaries,
  // since they describe work the agent performed (file edits, commands).
  if (acc.toolCalls.size > 0) {
    return [...acc.toolCalls.values()].map(tc => tc.summary).join('; ');
  }

  // No content at all (e.g. message was created but never had parts — perhaps
  // due to a crash mid-stream, or had only non-tool non-text parts). Skip.
  return null;
}

function joinTextParts(parts: Map<string, string>): string {
  return [...parts.values()].join('').trim();
}

function extractSummaryBody(info: UserInfo | AssistantInfo | null): string | null {
  if (!info || info.role !== 'user') return null;
  // info.summary is typed as { title?: string; body?: string } | undefined
  const parsed = UserMessageSummary.safeParse(info.summary);
  if (!parsed.success) return null;
  return parsed.data.body ?? null;
}

type ToolPartFields = z.infer<typeof ToolPartData>;

function summarizeToolCall(part: ToolPartFields): ToolCallSummary {
  const toolName = part.tool ?? 'unknown';
  const status = part.state?.status ?? 'unknown';
  const title = part.state?.title;

  // Build a one-liner: "bash: git status → ok" or "edit: src/foo.ts → completed"
  const inputBrief = title ?? truncateValue(part.state?.input, 60);
  const outputBrief = truncateValue(part.state?.output, 60);

  let summary = toolName;
  if (inputBrief) summary += `: ${inputBrief}`;
  if (outputBrief) summary += ` → ${outputBrief}`;
  else if (status !== 'unknown') summary += ` → ${status}`;

  return { tool: toolName, status, summary };
}

/** Truncate a value to a brief string for summaries. */
function truncateValue(value: unknown, maxLen: number): string {
  if (value === undefined || value === null) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ── Formatting for re-dispatch ────────────────────────────────────────────

/**
 * Format a reconstructed conversation transcript into a condensed string
 * suitable for injection into a re-dispatch prompt. Includes text content
 * and tool call summaries so the re-dispatched agent knows what it did.
 *
 * @param turns  Output of `reconstructConversation()`.
 * @param maxChars  Approximate character budget. Older turns are dropped
 *                  to fit. Defaults to 30_000 (~7.5k tokens).
 */
export function formatTranscriptForRedispatch(
  turns: ConversationTurn[],
  maxChars = 30_000
): string {
  // Build formatted lines from most recent to oldest, stopping when the budget is hit.
  const lines: string[] = [];
  let charCount = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    const formatted = formatTurn(turn);
    if (charCount + formatted.length > maxChars && lines.length > 0) break;
    lines.unshift(formatted);
    charCount += formatted.length;
  }

  return lines.join('\n\n');
}

function formatTurn(turn: ConversationTurn): string {
  const label = turn.role === 'user' ? 'User' : 'Assistant';
  let result = `[${label}]: ${turn.content}`;

  if (turn.toolCalls.length > 0) {
    const toolLines = turn.toolCalls.map(tc => `  - ${tc.summary}`);
    result += `\n[Tool calls]:\n${toolLines.join('\n')}`;
  }

  return result;
}
