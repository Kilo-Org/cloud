import type { Kilo2Message } from '../../../src/shared/kilo2-conversation.js';
import type { ActivityPart, ActivitySnapshotMessage, ActivityTool } from './harness-activity.js';

/**
 * Text and reasoning items are identified by their per-kind ordinal, as the
 * `session.text.*` and `session.reasoning.*` events report them, so deltas and
 * message reads address the same part.
 */
export const kilo2PartId = (messageId: string, kind: string, ordinal: string | number) =>
  `${messageId}_${kind}_${ordinal}`;

function toolActivity(
  item: NonNullable<Kilo2Message['content']>[number]
): ActivityTool | undefined {
  const state = item.state;
  if (!item.id || !item.name || !state) return;
  const metadata = state.metadata ?? {};
  const output =
    state.status === 'completed'
      ? (state.content ?? []).map(part => part.text ?? '').join('\n')
      : metadata['output'];
  return {
    callId: item.id,
    name: item.name,
    status: state.status === 'streaming' ? 'pending' : state.status,
    interactive: item.name === 'question' || item.name === 'suggest',
    ...(item.name === 'subagent' && typeof metadata['sessionID'] === 'string'
      ? { childSessionId: metadata['sessionID'] }
      : {}),
    ...(typeof output === 'string' ? { output } : {}),
    ...(state.status === 'error' ? { error: state.error?.message ?? 'Tool failed' } : {}),
  };
}

/**
 * Reads the model work in one native v2 message. Returns nothing for messages
 * that carry no conversation turn, such as a compaction still in progress.
 */
export function kilo2MessageActivity(
  sessionId: string,
  message: Kilo2Message
): ActivitySnapshotMessage | undefined {
  const base = { sessionId, id: message.id };
  if (message.type === 'user' || message.type === 'synthetic')
    return { ...base, role: 'user', time: message.time, parts: [] };
  const identity = (kind: string, ordinal: string | number) => ({
    sessionId,
    messageId: message.id,
    id: kilo2PartId(message.id, kind, ordinal),
  });
  if (message.type === 'compaction') {
    if (message.status !== 'completed') return;
    return {
      ...base,
      role: 'assistant',
      time: {
        created: message.time.created,
        completed: message.time.completed ?? message.time.created,
      },
      parts: [{ ...identity('text', 0), kind: 'text', text: message.summary ?? '' }],
    };
  }
  if (message.type !== 'assistant') return;
  const parts: ActivityPart[] = [];
  const ordinals = new Map<string, number>();
  for (const item of message.content ?? []) {
    const ordinal = ordinals.get(item.type) ?? 0;
    ordinals.set(item.type, ordinal + 1);
    if (item.type === 'text' || item.type === 'reasoning')
      parts.push({ ...identity(item.type, ordinal), kind: item.type, text: item.text ?? '' });
    else if (item.type === 'tool') {
      const tool = toolActivity(item);
      if (tool) parts.push({ ...identity('tool', tool.callId), kind: 'tool', tool });
    }
  }
  return {
    ...base,
    role: 'assistant',
    time: message.time,
    ...(message.error ? { error: message.error } : {}),
    parts,
  };
}
