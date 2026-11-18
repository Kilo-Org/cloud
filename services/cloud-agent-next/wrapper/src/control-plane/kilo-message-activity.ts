import { isRecord, kiloEventSessionId } from '../../../src/shared/kilo-event.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import type {
  ActivityMessage,
  ActivityPart,
  ActivityReads,
  ActivitySnapshotMessage,
  HarnessActivity,
} from './harness-activity.js';

const TOOL_STATUSES = new Set(['pending', 'running', 'completed', 'error']);

function messageActivity(sessionId: string, info: unknown): ActivityMessage | undefined {
  if (!isRecord(info) || typeof info.id !== 'string') return;
  if (info.role !== 'user' && info.role !== 'assistant') return;
  const time = isRecord(info.time) ? info.time : undefined;
  return {
    sessionId,
    id: info.id,
    role: info.role,
    ...(time && typeof time.created === 'number'
      ? {
          time: {
            created: time.created,
            ...(typeof time.completed === 'number' ? { completed: time.completed } : {}),
          },
        }
      : {}),
    ...(info.error === undefined ? {} : { error: info.error }),
  };
}

function partActivity(sessionId: string, raw: unknown): ActivityPart | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.messageID !== 'string') return;
  const base = { sessionId, messageId: raw.messageID, id: raw.id };
  if (raw.type === 'text' || raw.type === 'reasoning')
    return { ...base, kind: raw.type, ...(typeof raw.text === 'string' ? { text: raw.text } : {}) };
  if (raw.type !== 'tool' || typeof raw.callID !== 'string' || typeof raw.tool !== 'string') return;
  const state = isRecord(raw.state) ? raw.state : {};
  const status = String(state.status);
  if (!TOOL_STATUSES.has(status)) return;
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  // A running tool streams its output in metadata; a completed tool reports it in state.
  const output = state.output ?? metadata.output;
  return {
    ...base,
    kind: 'tool',
    tool: {
      callId: raw.callID,
      name: raw.tool,
      status: status as NonNullable<ActivityPart['tool']>['status'],
      interactive: raw.tool === 'question' || raw.tool === 'suggest',
      ...(raw.tool === 'task' && typeof metadata.sessionId === 'string'
        ? { childSessionId: metadata.sessionId }
        : {}),
      ...(typeof output === 'string' ? { output } : {}),
      ...(typeof state.error === 'string' ? { error: state.error } : {}),
    },
  };
}

/** Kilo v1 reports message work as `message.*` events; other events carry no activity. */
export function kiloActivity(type: string, properties: Record<string, unknown>): HarnessActivity[] {
  if (!type.startsWith('message.')) return [];
  const sessionId = kiloEventSessionId(properties);
  if (sessionId === undefined) return [];
  if (type === 'message.updated') {
    const message = messageActivity(sessionId, properties.info);
    return message ? [{ type: 'message', message }] : [];
  }
  if (type === 'message.part.updated') {
    const part = partActivity(sessionId, properties.part);
    return part ? [{ type: 'part', part }] : [];
  }
  if (
    type === 'message.part.delta' &&
    typeof properties.messageID === 'string' &&
    typeof properties.partID === 'string' &&
    typeof properties.delta === 'string' &&
    (properties.field === 'text' || properties.field === undefined)
  )
    return [
      {
        type: 'delta',
        sessionId,
        messageId: properties.messageID,
        partId: properties.partID,
        text: properties.delta,
      },
    ];
  return [];
}

/** Maps one Kilo v1 `{ info, parts }` message read. */
export function kiloSnapshotMessage(message: {
  info: unknown;
  parts: unknown[];
}): ActivitySnapshotMessage | undefined {
  const sessionId = isRecord(message.info) ? message.info.sessionID : undefined;
  if (typeof sessionId !== 'string') return;
  const info = messageActivity(sessionId, message.info);
  if (!info) return;
  return {
    ...info,
    parts: message.parts.flatMap(part => partActivity(sessionId, part) ?? []),
  };
}

export function kiloActivityReads(
  client: Pick<WrapperKiloClient, 'getRecentSessionMessages' | 'getSessionMessage'>
): ActivityReads {
  return {
    async getRecentActivity(sessionId, directory, signal) {
      const messages = await client.getRecentSessionMessages(sessionId, directory, signal);
      return messages.flatMap(message => kiloSnapshotMessage(message) ?? []);
    },
    async getMessageActivity(sessionId, directory, messageId, signal) {
      const message = kiloSnapshotMessage(
        await client.getSessionMessage(sessionId, directory, messageId, signal)
      );
      if (!message) throw new Error('Activity snapshot received an unknown message shape');
      return message;
    },
  };
}
