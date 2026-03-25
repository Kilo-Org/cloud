/**
 * Conversation reconstruction from AgentDO streaming events.
 *
 * When a container restarts, the Mayor (or any agent) loses its
 * in-memory conversation history. The AgentDO persists all SDK
 * streaming events in `rig_agent_events`. This module reassembles
 * those events into a conversation transcript that can be injected
 * into the agent's initial prompt on re-dispatch.
 */

import { z } from 'zod';

// ── Types ────────────────────────────────────────────────────────────

export type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

/**
 * Minimal event shape for conversation reconstruction. Accepts both the
 * Zod-parsed RigAgentEventRecord (where `data` is already an object)
 * and raw unknown[] from the TownDO RPC boundary.
 */
const AgentEventForReconstruction = z.object({
  id: z.number(),
  event_type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
type AgentEventForReconstruction = z.infer<typeof AgentEventForReconstruction>;

// ── Constants ────────────────────────────────────────────────────────

/** Maximum number of recent turns to keep in the reconstructed transcript. */
const MAX_TURNS = 50;

/**
 * Approximate max character budget for the transcript. At ~4 chars per
 * token, 40k chars ≈ 10k tokens — well within 20% of a 200k-token
 * context window.
 */
const MAX_TRANSCRIPT_CHARS = 40_000;

// ── Helpers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Reconstruction ──────────────────────────────────────────────────

/**
 * Build a `{role, content}` conversation from raw AgentDO events.
 *
 * Accepts `unknown[]` so callers don't need to cast across RPC boundaries.
 * Each element is validated with a lenient Zod schema; invalid events
 * are silently skipped.
 *
 * Strategy:
 *   1. Collect `message.updated` events that carry the full `Message`
 *      object with `role` and message metadata.
 *   2. Collect `message_part.updated` events, group by `messageID`,
 *      and keep the latest `text` part per part-id (streaming events
 *      overwrite earlier deltas).
 *   3. For each message, prefer assembled text-parts over `message.updated`
 *      content (the parts are more granular and always present).
 *   4. Truncate to the last N turns, respecting the character budget.
 */
export function reconstructConversation(rawEvents: unknown[]): ConversationTurn[] {
  // Validate events leniently — skip any that don't match the expected shape
  const events: AgentEventForReconstruction[] = [];
  for (const raw of rawEvents) {
    const parsed = AgentEventForReconstruction.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
  }

  // ── Phase 1: extract message metadata from message.updated events ──
  //
  // data.info = { id, role, sessionID, ... }
  const messageRoles = new Map<string, 'user' | 'assistant'>();

  for (const ev of events) {
    if (ev.event_type === 'message.updated' || ev.event_type === 'message.created') {
      const info = ev.data.info;
      if (!isRecord(info)) continue;
      if (typeof info.id !== 'string' || typeof info.role !== 'string') continue;
      const role = info.role === 'user' ? 'user' : 'assistant';
      messageRoles.set(info.id, role);
    }
  }

  // ── Phase 2: group text parts by messageID ──
  //
  // Each message_part.updated event has data.part = { id, messageID, type, text, ... }.
  // Streaming produces many events per part (progressively longer text).
  // We keep the latest text for each part ID, ordered by event ID.
  const partsByMessage = new Map<string, Map<string, { text: string; eventId: number }>>();

  for (const ev of events) {
    if (ev.event_type !== 'message_part.updated' && ev.event_type !== 'message.part.updated') {
      continue;
    }
    const part = ev.data.part;
    if (!isRecord(part)) continue;
    if (part.type !== 'text') continue;

    const messageID = typeof part.messageID === 'string' ? part.messageID : undefined;
    const partId = typeof part.id === 'string' ? part.id : undefined;
    const text = typeof part.text === 'string' ? part.text : undefined;
    if (!messageID || !partId || text === undefined) continue;

    let parts = partsByMessage.get(messageID);
    if (!parts) {
      parts = new Map();
      partsByMessage.set(messageID, parts);
    }

    const existing = parts.get(partId);
    if (!existing || ev.id > existing.eventId) {
      parts.set(partId, { text, eventId: ev.id });
    }
  }

  // ── Phase 3: assemble turns in event order ──
  //
  // For each unique messageID seen in parts, build one turn.
  // Order by the minimum event ID of parts within each message.
  type RawTurn = {
    messageId: string;
    role: 'user' | 'assistant';
    text: string;
    minEventId: number;
  };
  const turnMap = new Map<string, RawTurn>();

  for (const [messageId, parts] of partsByMessage) {
    const role = messageRoles.get(messageId) ?? 'assistant';
    const textParts = [...parts.values()];
    const text = textParts.map(p => p.text).join('');
    const minEventId = Math.min(...textParts.map(p => p.eventId));

    if (text.trim()) {
      turnMap.set(messageId, { messageId, role, text: text.trim(), minEventId });
    }
  }

  // Sort by event order
  const turns = [...turnMap.values()].sort((a, b) => a.minEventId - b.minEventId);

  // ── Phase 4: truncate to fit budget ──
  const recentTurns = turns.slice(-MAX_TURNS);
  const result: ConversationTurn[] = [];
  let charCount = 0;

  // Walk backwards from the most recent turn, accumulating until budget
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const turn = recentTurns[i];
    if (charCount + turn.text.length > MAX_TRANSCRIPT_CHARS && result.length > 0) break;
    result.unshift({ role: turn.role, content: turn.text });
    charCount += turn.text.length;
  }

  return result;
}

/**
 * Format a conversation transcript into a string suitable for injection
 * into an agent's initial prompt context.
 *
 * Uses JSON serialization inside the XML wrapper so that arbitrary
 * content in turns (including newlines, speaker labels like "User:",
 * or literal closing tags) cannot break the format. The `</` sequence
 * is escaped to `<\/` to prevent the JSON payload from containing a
 * literal closing tag that would prematurely end the wrapper block.
 */
export function formatTranscriptForPrompt(turns: ConversationTurn[]): string {
  if (turns.length === 0) return '';

  // Escape </ inside JSON to prevent closing-tag injection
  const safeJson = JSON.stringify(turns).replaceAll('</', '<\\/');

  return [
    '<prior-conversation>',
    'The following is your conversation history from a previous session.',
    'Continue naturally from where you left off.',
    '',
    safeJson,
    '</prior-conversation>',
  ].join('\n');
}
