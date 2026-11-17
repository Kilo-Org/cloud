import { z } from 'zod';
import { kilo2EventSchema, kilo2MessageSchema } from '@kilocode/session-ingest-contracts';
import type { NativeEvent } from './native-sync';
import {
  nativeSnapshotSessionSchema,
  type NativeSnapshotMessage,
  type NativeSnapshotSession,
} from './native-sync-snapshot';

const recordSchema = z.record(z.string(), z.unknown());
const optionalRecordSchema = recordSchema.optional().default({});
const messageSchema = z.intersection(kilo2MessageSchema, recordSchema);
const contentPartSchema = z.intersection(
  kilo2MessageSchema.shape.content.unwrap().element,
  recordSchema
);
const toolStateSchema = z.intersection(
  kilo2MessageSchema.shape.content.unwrap().element.shape.state.unwrap(),
  recordSchema
);
const modelSchema = z.intersection(kilo2MessageSchema.shape.model.unwrap(), recordSchema);
const errorSchema = z.intersection(kilo2MessageSchema.shape.error.unwrap(), recordSchema);
const tokensSchema = z.intersection(kilo2MessageSchema.shape.tokens.unwrap(), recordSchema);
const baseDataSchema = z.object({ sessionID: z.string().startsWith('ses_') }).passthrough();
const assistantDataSchema = baseDataSchema.extend({
  assistantMessageID: kilo2MessageSchema.shape.id,
});
const ordinalDataSchema = assistantDataSchema.extend({ ordinal: z.number().int().nonnegative() });
const toolDataSchema = assistantDataSchema.extend({ id: z.string() });
const inboxDataSchema = baseDataSchema.extend({ inboxID: kilo2MessageSchema.shape.id });
const shellSchema = z
  .object({
    id: z.string(),
    command: z.string(),
    status: z.enum(['running', 'exited', 'timeout', 'killed']),
    metadata: recordSchema,
    exit: z.number().optional(),
  })
  .passthrough();
const terminalStepFields = {
  rawFinish: z.string().optional(),
  native: recordSchema.optional(),
  snapshot: z.string().optional(),
  files: z.array(z.string()).optional(),
};
const terminalToolFields = {
  executed: z.boolean(),
  metadata: recordSchema.optional(),
  native: recordSchema.optional(),
};
const toolContentSchema = kilo2MessageSchema.shape.content
  .unwrap()
  .element.shape.state.unwrap()
  .shape.content.unwrap();
const nativeDataSchemas = new Map<string, z.ZodType<Record<string, unknown>>>([
  [
    'session.inbox.enqueued',
    inboxDataSchema.extend({
      item: z.object({ type: z.string(), payload: recordSchema.optional() }).passthrough(),
    }),
  ],
  ['session.inbox.cancelled', inboxDataSchema],
  ['session.inbox.delivered', inboxDataSchema],
  [
    'session.agent.selected',
    baseDataSchema.extend({ agent: z.string(), previous: z.string().optional() }),
  ],
  [
    'session.model.selected',
    baseDataSchema.extend({ model: modelSchema, previous: modelSchema.optional() }),
  ],
  ['session.renamed', baseDataSchema.extend({ title: z.string() })],
  [
    'session.message.content.updated',
    baseDataSchema.extend({
      messageID: kilo2MessageSchema.shape.id,
      content: kilo2MessageSchema.shape.content.unwrap(),
    }),
  ],
  ['session.metadata.updated', baseDataSchema.extend({ metadata: recordSchema })],
  [
    'session.instructions.updated',
    baseDataSchema.extend({ delta: recordSchema, text: z.string().optional() }),
  ],
  [
    'session.skill.activated',
    baseDataSchema.extend({ id: z.string(), name: z.string(), text: z.string() }),
  ],
  ['session.shell.started', baseDataSchema.extend({ shell: shellSchema })],
  ['session.shell.ended', baseDataSchema.extend({ shell: shellSchema, output: recordSchema })],
  ['session.execution.succeeded', baseDataSchema],
  ['session.execution.failed', baseDataSchema.extend({ error: errorSchema })],
  ['session.execution.interrupted', baseDataSchema.extend({ reason: z.string() })],
  [
    'session.synthetic',
    baseDataSchema.extend({
      text: z.string(),
      description: z.string().optional(),
      metadata: recordSchema.optional(),
    }),
  ],
  [
    'session.compaction.started',
    baseDataSchema.extend({
      inputID: kilo2MessageSchema.shape.id.optional(),
      reason: z.enum(['auto', 'manual']),
    }),
  ],
  [
    'session.compaction.ended',
    baseDataSchema.extend({
      reason: z.enum(['auto', 'manual']),
      text: z.string(),
      model: modelSchema.optional(),
      cost: z.number().optional(),
      tokens: tokensSchema.optional(),
      native: recordSchema.optional(),
    }),
  ],
  [
    'session.compaction.failed',
    baseDataSchema.extend({
      inputID: kilo2MessageSchema.shape.id.optional(),
      reason: z.enum(['auto', 'manual']),
      error: errorSchema,
      cost: z.number().optional(),
      tokens: tokensSchema.optional(),
    }),
  ],
  [
    'session.step.started',
    assistantDataSchema.extend({
      started: z.number().finite().nonnegative(),
      agent: z.string(),
      model: modelSchema,
      snapshot: z.string().optional(),
    }),
  ],
  ['session.step.streamed', assistantDataSchema],
  [
    'session.step.ended',
    assistantDataSchema.extend({
      ...terminalStepFields,
      finish: z.string(),
      cost: z.number(),
      tokens: tokensSchema,
    }),
  ],
  [
    'session.step.failed',
    assistantDataSchema.extend({
      ...terminalStepFields,
      finish: z.string().optional(),
      error: errorSchema,
      cost: z.number().optional(),
      tokens: tokensSchema.optional(),
    }),
  ],
  [
    'session.retry.scheduled',
    assistantDataSchema.extend({
      attempt: z.number().int().positive(),
      at: z.number().finite(),
      error: errorSchema,
    }),
  ],
  ['session.text.started', ordinalDataSchema],
  ['session.reasoning.started', ordinalDataSchema.extend({ native: recordSchema.optional() })],
  ['session.text.delta', ordinalDataSchema.extend({ delta: z.string() })],
  ['session.reasoning.delta', ordinalDataSchema.extend({ delta: z.string() })],
  [
    'session.text.ended',
    ordinalDataSchema.extend({ text: z.string(), native: recordSchema.optional() }),
  ],
  [
    'session.reasoning.ended',
    ordinalDataSchema.extend({ text: z.string(), native: recordSchema.optional() }),
  ],
  ['session.tool.input.started', toolDataSchema.extend({ name: z.string() })],
  ['session.tool.input.delta', toolDataSchema.extend({ delta: z.string() })],
  ['session.tool.input.ended', toolDataSchema.extend({ text: z.string() })],
  [
    'session.tool.called',
    toolDataSchema.extend({
      input: recordSchema,
      executed: z.boolean(),
      native: recordSchema.optional(),
    }),
  ],
  ['session.tool.progress', toolDataSchema.extend({ metadata: recordSchema })],
  [
    'session.tool.success',
    toolDataSchema.extend({ ...terminalToolFields, content: toolContentSchema }),
  ],
  [
    'session.tool.failed',
    toolDataSchema.extend({
      ...terminalToolFields,
      error: errorSchema,
      content: toolContentSchema.optional(),
    }),
  ],
]);
for (const [type, schema] of nativeDataSchemas)
  nativeDataSchemas.set(type, z.intersection(schema, recordSchema));
const nativeBodySchema = z.object({
  data: z.intersection(
    kilo2EventSchema.extend({ metadata: recordSchema.optional() }),
    recordSchema
  ),
});
function readNativeEvent(frame: NativeEvent) {
  const event = nativeBodySchema.parse(frame.body).data;
  if (event.type !== frame.type) throw new Error('Native event type mismatch');
  const schema = nativeDataSchemas.get(event.type);
  if (!schema) throw new Error('Unsupported native conversation event');
  return { ...event, data: schema.parse(event.data) };
}

/** Native public events use the runtime's message-updater semantics, not Cloud cursors. */
export function applyNativeEvent(
  messages: NativeSnapshotMessage[],
  frame: NativeEvent,
  session?: NativeSnapshotSession
): NativeSnapshotMessage[] {
  if (!nativeDataSchemas.has(frame.type)) return messages;
  const event = readNativeEvent(frame);
  const data = event.data;
  const created =
    frame.type.endsWith('.delta') || frame.type === 'session.tool.progress'
      ? event.created
      : z.number().finite().parse(event.created);
  const messageID = data['assistantMessageID'] ?? data['messageID'];
  const append = (value: unknown) => {
    const message = messageSchema.parse(value);
    if (messages.some(item => item.message.id === message.id)) return messages;
    return [...messages, { message, seq: frame.seq }];
  };
  if (frame.type === 'session.inbox.enqueued') {
    const item = recordSchema.parse(data['item']);
    if (item['type'] !== 'user' && item['type'] !== 'synthetic') return messages;
    const message = messageSchema.parse({
      ...recordSchema.parse(item['payload']),
      id: data['inboxID'],
      type: item['type'],
      time: { created },
    });
    if (messages.some(entry => entry.message.id === message.id))
      return messages.map(entry =>
        entry.message.id === message.id ? { ...entry, message } : entry
      );
    return [...messages, { message, seq: frame.seq }];
  }
  if (frame.type === 'session.inbox.cancelled')
    return messages.filter(item => item.message.id !== data['inboxID']);
  if (frame.type === 'session.inbox.delivered') {
    const current = messages.find(item => item.message.id === data['inboxID']);
    if (!current) return messages;
    return [
      ...messages.filter(item => item !== current),
      {
        ...current,
        message: {
          ...current.message,
          time: { ...current.message.time, created: z.number().parse(created) },
        },
      },
    ];
  }
  if (frame.type === 'session.agent.selected' || frame.type === 'session.model.selected') {
    const agent = frame.type === 'session.agent.selected';
    return append({
      id: messageIDFromEvent(event),
      type: agent ? 'agent-switched' : 'model-switched',
      metadata: event['metadata'],
      time: { created },
      ...(agent
        ? { agent: data['agent'], previous: data['previous'] ?? session?.agent }
        : { model: data['model'], previous: data['previous'] ?? session?.model }),
    });
  }
  if (frame.type === 'session.instructions.updated' && data['text'] !== undefined)
    return append({
      id: messageIDFromEvent(event),
      type: 'system',
      text: data['text'],
      description: `Instructions updated: ${Object.keys(recordSchema.parse(data['delta'])).join(', ')}`,
      metadata: {
        ...optionalRecordSchema.parse(event['metadata']),
        notice: 'instructions',
        instructionSources: Object.keys(recordSchema.parse(data['delta'])),
      },
      time: { created },
    });
  if (frame.type === 'session.skill.activated')
    return append({
      id: messageIDFromEvent(event),
      type: 'skill',
      skill: data['id'],
      name: data['name'],
      text: data['text'],
      metadata: event['metadata'],
      time: { created },
    });
  if (frame.type === 'session.shell.started') {
    const shell = recordSchema.parse(data['shell']);
    return append({
      id: messageIDFromEvent(event),
      type: 'shell',
      shellID: shell['id'],
      command: shell['command'],
      status: shell['status'],
      metadata:
        recordSchema.parse(shell['metadata'])['background'] === true
          ? { ...optionalRecordSchema.parse(event['metadata']), background: true }
          : event['metadata'],
      time: { created },
    });
  }
  if (frame.type === 'session.shell.ended') {
    const shell = recordSchema.parse(data['shell']);
    return messages.map(item =>
      item.message.type !== 'shell' || item.message['shellID'] !== shell['id']
        ? item
        : {
            ...item,
            message: messageSchema.parse({
              ...item.message,
              status: shell['status'],
              exit: shell['exit'],
              output: data['output'],
              time: { ...item.message.time, completed: created },
            }),
          }
    );
  }
  if (frame.type.startsWith('session.execution.') && frame.type !== 'session.execution.started') {
    let currentAssistant = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.message.type === 'assistant') {
        currentAssistant = index;
        break;
      }
    }
    const settled = messages.map((item, index) =>
      index === currentAssistant && item.message.retry
        ? { ...item, message: { ...item.message, retry: undefined } }
        : item
    );
    if (frame.type === 'session.execution.interrupted' && data['reason'] === 'shutdown')
      return settled;
    const message = messageSchema.parse({
      id: messageIDFromEvent(event),
      type: 'idle',
      outcome:
        frame.type === 'session.execution.succeeded'
          ? 'succeeded'
          : frame.type === 'session.execution.failed'
            ? 'failed'
            : 'interrupted',
      ...(frame.type === 'session.execution.failed' ? { error: data['error'] } : {}),
      metadata: event['metadata'],
      time: { created },
    });
    return [...settled, { message, seq: frame.seq }];
  }
  if (frame.type === 'session.synthetic')
    return append({
      text: data['text'],
      description: data['description'],
      metadata: data['metadata'],
      id: messageIDFromEvent(event),
      type: 'synthetic',
      time: { created },
    });
  if (frame.type === 'session.compaction.started')
    return append({
      id: data['inputID'] ?? messageIDFromEvent(event),
      type: 'compaction',
      status: 'running',
      reason: data['reason'],
      metadata: event['metadata'],
      summary: '',
      time: { created },
    });
  if (frame.type === 'session.compaction.ended' || frame.type === 'session.compaction.failed') {
    let current: NativeSnapshotMessage | undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.message.type === 'compaction') {
        current = messages[index];
        break;
      }
    }
    const failed = frame.type === 'session.compaction.failed';
    const value = {
      ...(current?.message.status === 'running' ? current.message : {}),
      id:
        current?.message.status === 'running'
          ? current.message.id
          : (data['inputID'] ?? messageIDFromEvent(event)),
      type: 'compaction',
      status: failed ? 'failed' : 'completed',
      reason: data['reason'],
      cost: data['cost'],
      tokens: data['tokens'],
      metadata: failed
        ? (current?.message['metadata'] ?? event['metadata'])
        : event['metadata']
          ? {
              ...optionalRecordSchema.parse(current?.message['metadata']),
              ...recordSchema.parse(event['metadata']),
            }
          : current?.message['metadata'],
      ...(failed
        ? { error: data['error'] }
        : { model: data['model'], native: data['native'], summary: data['text'] }),
      time: current?.message.status === 'running' ? current.message.time : { created },
    };
    if (current?.message.status !== 'running') return append(value);
    return messages.map(item =>
      item !== current ? item : { ...item, message: messageSchema.parse(value) }
    );
  }
  if (typeof messageID !== 'string') return messages;
  if (
    frame.type === 'session.step.started' &&
    !messages.some(item => item.message.id === messageID)
  ) {
    let priorAssistant = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.message.type === 'assistant') {
        priorAssistant = index;
        break;
      }
    }
    const prior = messages.map((item, index) =>
      index === priorAssistant
        ? {
            ...item,
            message: messageSchema.parse({
              ...item.message,
              retry: undefined,
              time: { ...item.message.time, completed: created },
            }),
          }
        : item
    );
    return [
      ...prior,
      {
        seq: frame.seq,
        message: messageSchema.parse({
          id: messageID,
          type: 'assistant',
          agent: data['agent'],
          model: data['model'],
          metadata: event['metadata'],
          time: { created: data['started'] },
          content: [],
          ...(data['snapshot'] ? { snapshot: { start: data['snapshot'] } } : {}),
        }),
      },
    ];
  }
  return messages.map(item => {
    if (item.message.id !== messageID || item.message.type !== 'assistant') return item;
    const message = item.message;
    if (
      message.time.completed !== undefined &&
      (frame.type.endsWith('.delta') || frame.type === 'session.tool.progress')
    )
      return item;
    let contentToKeep = message.content;
    let next: Record<string, unknown> = { ...message };
    if (frame.type === 'session.step.started') {
      next = {
        ...next,
        agent: data['agent'],
        model: data['model'],
        retry: undefined,
        error: undefined,
        finish: undefined,
        rawFinish: undefined,
        native: undefined,
        time: {
          ...message.time,
          created: data['started'],
          streamed: undefined,
          completed: undefined,
        },
        ...(data['snapshot']
          ? {
              snapshot: {
                ...optionalRecordSchema.parse(message['snapshot']),
                start: data['snapshot'],
              },
            }
          : {}),
      };
    } else if (frame.type === 'session.step.streamed') {
      next['time'] = { ...message.time, streamed: created };
    } else if (frame.type === 'session.step.ended' || frame.type === 'session.step.failed') {
      next = {
        ...next,
        time: { ...message.time, completed: created },
        finish: data['finish'] ?? 'error',
        rawFinish: data['rawFinish'],
        native: data['native'],
        ...(frame.type === 'session.step.failed' ? { error: data['error'], retry: undefined } : {}),
        ...(data['cost'] !== undefined && data['tokens'] !== undefined
          ? { cost: data['cost'], tokens: data['tokens'] }
          : {}),
        ...(data['snapshot'] || data['files']
          ? {
              snapshot: {
                ...optionalRecordSchema.parse(message['snapshot']),
                end: data['snapshot'],
                files: data['files'],
              },
            }
          : {}),
      };
    } else if (frame.type === 'session.retry.scheduled') {
      next['retry'] = { attempt: data['attempt'], at: data['at'], error: data['error'] };
    } else if (frame.type === 'session.message.content.updated') {
      next['content'] = data['content'];
      contentToKeep = undefined;
    } else {
      const content = [...(message.content ?? [])];
      const kind = frame.type.startsWith('session.reasoning.') ? 'reasoning' : 'text';
      if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(frame.type)) {
        const ordinal = z.number().int().nonnegative().parse(data['ordinal']);
        let index: number | undefined;
        let seen = 0;
        for (let position = 0; position < content.length; position++) {
          if (content[position]?.type === kind && seen++ === ordinal) {
            index = position;
            break;
          }
        }
        if (index === undefined) {
          // A replay may start with an ephemeral delta at the durable snapshot frontier.
          // Missing preceding parts stay incomplete until native snapshot recovery succeeds.
          if (ordinal !== seen) return { ...item, incomplete: true };
          index = content.length;
          content.push({
            type: kind,
            text: '',
            ...(kind === 'reasoning'
              ? {
                  time: { created: typeof created === 'number' ? created : message.time.created },
                  native: data['native'],
                }
              : {}),
          });
        }
        const previous = content[index];
        if (!previous) return item;
        content[index] = contentPartSchema.parse({
          ...previous,
          text: frame.type.endsWith('.delta')
            ? `${previous.text ?? ''}${z.string().parse(data['delta'])}`
            : frame.type.endsWith('.started')
              ? ''
              : z.string().parse(data['text']),
          ...(frame.type.endsWith('.ended') && data['native'] !== undefined
            ? { native: data['native'] }
            : {}),
          ...(kind === 'reasoning' && frame.type.endsWith('.ended')
            ? {
                time: {
                  ...previous.time,
                  created: previous.time?.created ?? created,
                  completed: created,
                },
              }
            : {}),
        });
      } else if (frame.type.startsWith('session.tool.')) {
        let index = -1;
        for (let position = content.length - 1; position >= 0; position--) {
          if (content[position]?.type === 'tool' && content[position]?.id === data['id']) {
            index = position;
            break;
          }
        }
        if (frame.type === 'session.tool.input.started') {
          index = content.length;
          content.push({
            type: 'tool',
            id: z.string().parse(data['id']),
            name: z.string().parse(data['name']),
            time: { created: z.number().parse(created) },
            state: { status: 'streaming', input: '' },
          });
        }
        const previous = content[index];
        if (!previous?.state) return { ...item, incomplete: true };
        const part = { ...previous };
        content[index] = part;
        const state = previous.state;
        if (frame.type === 'session.tool.input.delta' && state.status === 'streaming')
          part.state = {
            ...state,
            input: `${z.string().parse(state.input)}${z.string().parse(data['delta'])}`,
          };
        else if (frame.type === 'session.tool.input.ended' && state.status === 'streaming')
          part.state = { ...state, input: z.string().parse(data['text']) };
        else if (frame.type === 'session.tool.called') {
          part['executed'] = data['executed'];
          part['native'] = data['native'];
          part.time = {
            ...part.time,
            created: part.time?.created ?? z.number().parse(created),
            ran: z.number().parse(created),
          };
          part.state = {
            status: 'running',
            input: z.record(z.string(), z.unknown()).parse(data['input']),
            metadata: {},
          };
        } else if (frame.type === 'session.tool.progress' && state.status === 'running')
          part.state = { ...state, metadata: recordSchema.parse(data['metadata']) };
        else if (
          (frame.type === 'session.tool.success' && state.status === 'running') ||
          (frame.type === 'session.tool.failed' &&
            (state.status === 'streaming' || state.status === 'running'))
        ) {
          part['executed'] = data['executed'] === true || part['executed'] === true;
          if (data['native'] !== undefined)
            part['native'] = {
              ...optionalRecordSchema.parse(part['native']),
              ...recordSchema.parse(data['native']),
            };
          part.time = {
            ...part.time,
            created: part.time?.created ?? z.number().parse(created),
            completed: z.number().parse(created),
          };
          // Terminal events are self-contained: do not retain ephemeral progress metadata.
          part.state = toolStateSchema.parse({
            status: frame.type === 'session.tool.success' ? 'completed' : 'error',
            input: typeof state.input === 'string' ? {} : state.input,
            ...(data['metadata'] === undefined ? {} : { metadata: data['metadata'] }),
            ...(data['content'] === undefined ? {} : { content: data['content'] }),
            ...(frame.type === 'session.tool.failed' ? { error: data['error'] } : {}),
          });
        }
      } else return item;
      next['content'] = content;
      contentToKeep = content;
    }
    const validated = messageSchema.parse(next);
    if (contentToKeep !== undefined) validated.content = contentToKeep;
    const updated: NativeSnapshotMessage = {
      ...item,
      message: validated,
    };
    if (frame.type === 'session.message.content.updated') delete updated.partOrdinals;
    return updated;
  });
}

function messageIDFromEvent(event: Record<string, unknown>): string {
  return z.string().startsWith('evt_').parse(event['id']).replace(/^evt_/, 'msg_');
}

/** Session identity remains the portable snapshot identity, never a runtime root grant. */
export function applyNativeSessionEvent(
  session: NativeSnapshotSession | undefined,
  frame: NativeEvent
): NativeSnapshotSession | undefined {
  if (
    ![
      'session.agent.selected',
      'session.model.selected',
      'session.renamed',
      'session.metadata.updated',
    ].includes(frame.type)
  )
    return session;
  const event = readNativeEvent(frame);
  const data = event.data;
  if (!session) return session;
  if (frame.type === 'session.agent.selected')
    return nativeSnapshotSessionSchema.parse({
      ...session,
      agent: z.string().parse(data['agent']),
    });
  if (frame.type === 'session.model.selected')
    return nativeSnapshotSessionSchema.parse({ ...session, model: data['model'] });
  if (frame.type === 'session.renamed')
    return nativeSnapshotSessionSchema.parse({
      ...session,
      title: z.string().parse(data['title']),
    });
  if (frame.type === 'session.metadata.updated')
    return nativeSnapshotSessionSchema.parse({
      ...session,
      metadata: z.record(z.string(), z.json()).parse(data['metadata']),
    });
  return session;
}
