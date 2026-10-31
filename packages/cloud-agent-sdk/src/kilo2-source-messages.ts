import type { Part, SessionSnapshot } from './types';
import type { Kilo2Message, Kilo2Session } from '@kilocode/session-ingest-contracts';

export const kilo2PartId = (messageId: string, kind: string, ordinal: string | number) =>
  `${messageId}_${kind}_${ordinal}`;
type ProjectedKilo2Message = SessionSnapshot['messages'][number];

/** Project native v2 messages once, for both Cloud history and live observation. */
export function readKilo2Messages(
  session: Kilo2Session,
  messages: Kilo2Message[]
): ProjectedKilo2Message[] {
  const result: ProjectedKilo2Message[] = [];
  let parentID = '';
  for (const message of messages) {
    const base = { id: message.id, sessionID: session.id };
    const model = message.model ?? session.model;
    const agent = message.agent ?? session.agent ?? 'build';
    if (message.type === 'user' || message.type === 'synthetic') {
      parentID = message.id;
      result.push({
        info: {
          ...base,
          role: 'user',
          time: message.time,
          agent,
          model: { providerID: model?.providerID ?? 'kilo', modelID: model?.id ?? '' },
        },
        parts: [
          {
            ...base,
            id: kilo2PartId(message.id, 'text', 0),
            messageID: message.id,
            type: 'text',
            text: message.text ?? '',
            ...(message.type === 'synthetic' ? { synthetic: true } : {}),
          },
          ...(message.files ?? []).map((file, index): Part => ({
            ...base,
            id: kilo2PartId(message.id, 'file', index),
            messageID: message.id,
            type: 'file',
            mime: file.mime,
            url:
              file.source.type === 'uri'
                ? file.source.uri
                : `data:${file.mime};base64,${file.data}`,
            ...(file.name === undefined ? {} : { filename: file.name }),
          })),
        ],
      });
      continue;
    }
    const compaction = message.type === 'compaction' && message.status === 'completed';
    if (message.type !== 'assistant' && !compaction) continue;
    const info: SessionSnapshot['messages'][number]['info'] = {
      ...base,
      role: 'assistant',
      time: {
        created: message.time.created,
        ...(compaction || message.time.completed !== undefined
          ? { completed: message.time.completed ?? message.time.created }
          : {}),
      },
      parentID,
      agent,
      mode: agent,
      modelID: model?.id ?? '',
      providerID: model?.providerID ?? 'kilo',
      path: { cwd: session.location.directory, root: session.location.directory },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(message.finish ? { finish: message.finish } : {}),
      ...(compaction ? { summary: true } : {}),
      ...(message.error
        ? { error: { name: 'UnknownError', data: { message: message.error.message } } as const }
        : {}),
    };
    const parts: Part[] = [];
    if (compaction)
      parts.push({
        id: kilo2PartId(message.id, 'text', 0),
        messageID: message.id,
        sessionID: session.id,
        type: 'text',
        text: message.summary ?? '',
      });
    const ordinals = new Map<string, number>();
    for (const item of message.content ?? []) {
      const ordinal = ordinals.get(item.type) ?? 0;
      ordinals.set(item.type, ordinal + 1);
      const identity = {
        id: kilo2PartId(message.id, item.type, item.id ?? ordinal),
        messageID: message.id,
        sessionID: session.id,
      };
      if (item.type === 'text') parts.push({ ...identity, type: 'text', text: item.text ?? '' });
      else if (item.type === 'reasoning')
        parts.push({
          ...identity,
          type: 'reasoning',
          text: item.text ?? '',
          time: {
            start: item.time?.created ?? message.time.created,
            ...(item.time?.completed === undefined ? {} : { end: item.time.completed }),
          },
        });
      else if (item.type === 'tool' && item.id && item.name && item.state) {
        const state = item.state;
        const start = item.time?.ran ?? item.time?.created ?? message.time.created;
        const nativeInput = typeof state.input === 'string' ? {} : state.input;
        const nativeMetadata = state.metadata ?? {};
        // The shared task card uses v1 field names. Keep these aliases in the
        // display model so native messages remain intact for history and replay.
        const input =
          item.name === 'subagent' && typeof nativeInput['agent'] === 'string'
            ? { ...nativeInput, subagent_type: nativeInput['agent'] }
            : nativeInput;
        const metadata =
          item.name === 'subagent' && typeof nativeMetadata['sessionID'] === 'string'
            ? { ...nativeMetadata, sessionId: nativeMetadata['sessionID'] }
            : nativeMetadata;
        const tool = {
          ...identity,
          type: 'tool' as const,
          callID: item.id,
          tool: item.name === 'shell' ? 'bash' : item.name === 'subagent' ? 'task' : item.name,
        };
        if (state.status === 'streaming')
          parts.push({
            ...tool,
            state: {
              status: 'pending',
              input,
              raw: typeof state.input === 'string' ? state.input : '',
            },
          });
        else if (state.status === 'running')
          parts.push({ ...tool, state: { status: 'running', input, metadata, time: { start } } });
        else if (state.status === 'completed')
          parts.push({
            ...tool,
            state: {
              status: 'completed',
              input,
              metadata,
              title: item.name,
              output: (state.content ?? []).map(part => part.text ?? '').join('\n'),
              time: { start, end: item.time?.completed ?? start },
            },
          });
        else
          parts.push({
            ...tool,
            state: {
              status: 'error',
              input,
              metadata,
              error: state.error?.message ?? 'Tool failed',
              time: { start, end: item.time?.completed ?? start },
            },
          });
      }
    }
    result.push({ info, parts });
  }
  return result;
}
