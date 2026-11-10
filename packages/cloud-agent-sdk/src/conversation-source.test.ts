import { createConversationSourceReader } from './conversation-source';
import { cloudSessionMessagesPageSchema, cloudSessionMessagesPageWireSchema } from './schemas';
import type { CloudAgentEvent } from './cloud-conversation-schemas';
import type { MessageInfo } from './types';
import {
  hasUnresolvedKilo2Assets,
  kilo2AssetKey,
  kilo2ToolFileId,
  readKilo2Messages,
} from './kilo2-source-messages';
import { kilo2MessageSchema, kilo2PartId } from '@kilocode/session-ingest-contracts';

const session = {
  id: 'ses_source',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
  model: { providerID: 'kilo', id: 'fake' },
};
const source = { version: 'v2' as const, session };
const user = { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'remember this' };
const assistant = {
  id: 'msg_assistant',
  type: 'assistant',
  time: { created: 2, completed: 3 },
  content: [
    { type: 'reasoning', text: 'thinking', native: { signature: 'provider-replay-field' } },
    { type: 'text', text: 'done' },
    {
      type: 'tool',
      id: 'call_shell',
      name: 'shell',
      state: {
        status: 'completed',
        input: { command: 'pwd' },
        content: [{ type: 'text', text: '/workspace/app' }],
      },
    },
  ],
};
const page = {
  kind: 'success',
  source,
  info: { id: session.id },
  messages: [{ message: user }, { message: assistant, parentID: user.id }],
  nextCursor: null,
  omittedItemCount: 0,
  updateCursor: 8,
  totalCostMicrodollars: 0,
};
function wire(type: string, properties: unknown): CloudAgentEvent {
  return {
    eventId: 1,
    cursor: 8,
    sessionId: 'workspace_test',
    streamEventType: 'kilocode',
    timestamp: '2026-10-23T09:00:00Z',
    data: { type, properties },
  };
}

describe('versioned native conversation sources', () => {
  it.each(['user', 'assistant'])(
    'retains the native %s model variant in history and live updates',
    type => {
      const message = {
        ...(type === 'user' ? user : assistant),
        model: { providerID: 'kilo', id: 'fake', variant: 'high' },
      };
      const display = cloudSessionMessagesPageSchema.parse({
        ...page,
        messages: [{ message }],
      });
      expect(display?.messages[0].info).toMatchObject({ variant: 'high' });
      const events = createConversationSourceReader().read(
        wire('conversation.message.updated', {
          sessionID: session.id,
          source,
          message,
        })
      ).events;
      expect(events[0]).toMatchObject({ type: 'message.updated', info: { variant: 'high' } });
    }
  );

  it('uses the session variant only when the native message has no model selection', () => {
    const selectedSession = { ...session, model: { ...session.model, variant: 'high' } };
    const nativeAssistant = kilo2MessageSchema.parse(assistant);
    expect(
      readKilo2Messages(selectedSession, [user, nativeAssistant]).map(item => item.info.variant)
    ).toEqual(['high', 'high']);
    expect(
      readKilo2Messages(selectedSession, [{ ...nativeAssistant, model: session.model }])[0]?.info
        .variant
    ).toBeUndefined();
  });

  it('keeps native fields on the wire and builds the shared display model only inside the SDK', () => {
    expect(cloudSessionMessagesPageWireSchema.parse(page)).toEqual(page);
    const display = cloudSessionMessagesPageSchema.parse(page);
    expect(display?.sourceVersion).toBe('v2');
    expect(display?.messages[0].parts[0]).toMatchObject({ type: 'text', text: 'remember this' });
    expect(display?.messages[1].info).toMatchObject({
      role: 'assistant',
      parentID: user.id,
      modelID: 'fake',
    });
    expect(display?.messages[1].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', text: 'thinking' }),
        expect.objectContaining({
          type: 'tool',
          tool: 'bash',
          state: expect.objectContaining({ status: 'completed', output: '/workspace/app' }),
        }),
      ])
    );
    expect(page.messages[1].message).toEqual(assistant);
  });

  it('counts native messages it cannot show as omitted, but not a compaction in progress', () => {
    const display = cloudSessionMessagesPageSchema.parse({
      ...page,
      messages: [
        ...page.messages,
        { message: { id: 'msg_unknown', type: 'future-kind', time: { created: 4 } } },
        {
          message: {
            id: 'msg_compacting',
            type: 'compaction',
            status: 'running',
            time: { created: 5 },
          },
        },
      ],
    });
    expect(display?.messages.map(message => message.info.id)).toEqual([user.id, assistant.id]);
    expect(display?.omittedItemCount).toBe(1);
  });

  it('supports v1 data and rejects unknown source versions', () => {
    const sourceReader = createConversationSourceReader();
    const reader = { read: (raw: CloudAgentEvent) => sourceReader.read(raw).events };
    expect(
      reader.read(
        wire('message.updated', {
          info: { id: 'msg_v1', sessionID: session.id, role: 'user', time: { created: 1 } },
        })
      )
    ).toEqual([
      expect.objectContaining({
        type: 'message.updated',
        info: expect.objectContaining({ id: 'msg_v1' }),
      }),
    ]);
    expect(
      cloudSessionMessagesPageWireSchema.safeParse({ ...page, source: { version: 'v3' } }).success
    ).toBe(false);
  });

  it('uses one display projection for native snapshots and live updates', () => {
    const sourceReader = createConversationSourceReader();
    const reader = { read: (raw: CloudAgentEvent) => sourceReader.read(raw).events };
    const events = reader.read(
      wire('conversation.message.updated', {
        sessionID: session.id,
        source,
        message: assistant,
        parentID: user.id,
      })
    );
    const display = cloudSessionMessagesPageSchema.parse(page)?.messages[1];
    expect(events[0]).toEqual({ type: 'message.updated', info: display?.info });
    expect(events.slice(1)).toEqual(
      display?.parts.map(part => ({ type: 'message.part.updated', part }))
    );
  });

  it.each(['running', 'completed'] as const)(
    'links %s native subagents in snapshots and live updates',
    status => {
      const childId = `ses_${'b'.repeat(26)}`;
      const message = {
        ...assistant,
        content: [
          {
            type: 'tool',
            id: 'call_subagent',
            name: 'subagent',
            state: {
              status,
              input: { agent: 'explore', description: 'Inspect commands', prompt: 'Run pwd' },
              metadata: { sessionID: childId, status: 'running' },
              content: [{ type: 'text', text: 'Delegated' }],
            },
          },
        ],
      };
      const display = cloudSessionMessagesPageSchema.parse({
        ...page,
        messages: [{ message }],
      });
      expect(display?.messages[0].parts[0]).toMatchObject({
        tool: 'task',
        state: {
          status,
          input: { subagent_type: 'explore', description: 'Inspect commands' },
          metadata: { sessionId: childId },
        },
      });
      const events = createConversationSourceReader().read(
        wire('conversation.message.updated', { sessionID: session.id, source, message })
      ).events;
      expect(events[1]).toEqual({
        type: 'message.part.updated',
        part: display?.messages[0].parts[0],
      });
      // Display aliases must not change native history or its replay fields.
      expect(message.content[0].state.metadata).toEqual({ sessionID: childId, status: 'running' });
    }
  );

  it.each([undefined, 12, ['ses_invalid']])(
    'does not create a child session link from invalid native metadata %j',
    sessionID => {
      const display = cloudSessionMessagesPageSchema.parse({
        ...page,
        messages: [
          {
            message: {
              ...assistant,
              content: [
                {
                  type: 'tool',
                  id: 'call_subagent',
                  name: 'subagent',
                  state: {
                    status: 'running',
                    input: { agent: 'explore' },
                    metadata: { sessionID },
                  },
                },
              ],
            },
          },
        ],
      });
      const part = display?.messages[0].parts[0];
      if (part?.type !== 'tool' || part.state.status !== 'running')
        throw new Error('Expected a running subagent tool');
      expect(part.state.metadata?.sessionId).toBeUndefined();
    }
  );

  it('streams native text with stable identities and ignores stale deltas after a completed snapshot', () => {
    const sourceReader = createConversationSourceReader();
    const reader = { read: (raw: CloudAgentEvent) => sourceReader.read(raw).events };
    const event = {
      id: 'evt_delta',
      type: 'session.text.delta',
      data: { sessionID: session.id, assistantMessageID: assistant.id, ordinal: 0, delta: 'chunk' },
    };
    const raw = wire('conversation.event', {
      sessionID: session.id,
      source: { version: 'v2' },
      event,
    });
    expect(reader.read(raw)).toEqual([
      {
        type: 'message.part.delta',
        sessionId: session.id,
        messageId: assistant.id,
        partId: `${assistant.id}_000000`,
        field: 'text',
        delta: 'chunk',
      },
    ]);
    reader.read(
      wire('conversation.message.updated', { sessionID: session.id, source, message: assistant })
    );
    expect(reader.read(raw)).toEqual([]);
  });

  it.each([false, true])(
    'preserves reasoning duration after a live start or a projected page (%p)',
    projected => {
      const reader = createConversationSourceReader();
      const reasoning = (type: string, created: number) =>
        reader.read(
          wire('conversation.event', {
            sessionID: session.id,
            source: { version: 'v2' },
            event: {
              id: `evt_${type}`,
              type,
              created,
              data: {
                sessionID: session.id,
                assistantMessageID: 'msg_live',
                ordinal: 0,
                text: 'thinking',
              },
            },
          })
        ).events;
      if (projected)
        reader.observeProjected([
          {
            info: {
              id: 'msg_live',
              sessionID: session.id,
              role: 'assistant',
              time: { created: 1 },
            } as MessageInfo,
            parts: [
              {
                id: 'msg_live_000000',
                sessionID: session.id,
                messageID: 'msg_live',
                type: 'reasoning',
                text: 'thinking',
                time: { start: 10 },
              },
            ],
          },
        ]);
      else reasoning('session.reasoning.started', 10);
      expect(reasoning('session.reasoning.ended', 30)).toEqual([
        expect.objectContaining({
          type: 'message.part.updated',
          part: expect.objectContaining({ time: { start: 10, end: 30 } }),
        }),
      ]);
    }
  );

  it('orders live text after a tool by native content position', () => {
    const sourceReader = createConversationSourceReader();
    const read = (type: string, properties: object) =>
      sourceReader.read(wire(type, { sessionID: session.id, source, ...properties })).events;
    const text = (type: string, ordinal: number, data: object = {}) =>
      read('conversation.event', {
        event: {
          id: `evt_${type}_${ordinal}`,
          type,
          data: { sessionID: session.id, assistantMessageID: 'msg_live', ordinal, ...data },
        },
      });
    const partIds = (events: ReturnType<typeof read>) =>
      events.flatMap(event =>
        event.type === 'message.part.updated'
          ? [event.part.id]
          : event.type === 'message.part.delta'
            ? [event.partId]
            : []
      );
    const tool = {
      type: 'tool',
      id: 'call_shell',
      name: 'shell',
      state: { status: 'running', input: { command: 'pwd' } },
    };
    const snapshot = (content: unknown[]) =>
      read('conversation.message.updated', {
        message: { id: 'msg_live', type: 'assistant', time: { created: 2 }, content },
      });

    expect(partIds(text('session.text.started', 0))).toEqual(['msg_live_000000']);
    expect(partIds(snapshot([{ type: 'text', text: 'before' }, tool]))).toEqual([
      'msg_live_000000',
      'msg_live_000001',
    ]);
    // The second text item follows the tool, although its text ordinal is 1.
    expect(partIds(text('session.text.started', 1))).toEqual(['msg_live_000002']);
    expect(partIds(text('session.text.delta', 1, { delta: 'af' }))).toEqual(['msg_live_000002']);
    // A snapshot that already holds the item keeps its identity, so no part is duplicated.
    expect(
      partIds(snapshot([{ type: 'text', text: 'before' }, tool, { type: 'text', text: 'after' }]))
    ).toEqual(['msg_live_000000', 'msg_live_000001', 'msg_live_000002']);
    expect(partIds(text('session.text.ended', 1, { text: 'after' }))).toEqual(['msg_live_000002']);
    expect(partIds(text('session.reasoning.started', 0))).toEqual(['msg_live_000003']);
  });

  it('keeps live text positions after a projected page the reader did not snapshot', () => {
    const sourceReader = createConversationSourceReader();
    sourceReader.observeProjected([
      {
        info: {
          id: 'msg_live',
          sessionID: session.id,
          role: 'assistant',
          time: { created: 2 },
        } as MessageInfo,
        parts: [
          {
            id: 'msg_live_000000',
            sessionID: session.id,
            messageID: 'msg_live',
            type: 'text',
            text: 'before',
          },
          {
            id: 'msg_live_000001',
            sessionID: session.id,
            messageID: 'msg_live',
            type: 'tool',
            callID: 'call_shell',
            tool: 'bash',
            state: { status: 'running', input: { command: 'pwd' }, time: { start: 2 } },
          },
        ],
      },
    ]);
    const events = sourceReader.read(
      wire('conversation.event', {
        sessionID: session.id,
        source: { version: 'v2' },
        event: {
          id: 'evt_text_1',
          type: 'session.text.delta',
          data: {
            sessionID: session.id,
            assistantMessageID: 'msg_live',
            ordinal: 1,
            delta: 'af',
          },
        },
      })
    ).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'message.part.delta', partId: 'msg_live_000002' }),
    ]);
  });

  it('keeps a newer live layout when a projected page of the message is older', () => {
    const sourceReader = createConversationSourceReader();
    const read = (type: string, properties: object) =>
      sourceReader.read(wire(type, { sessionID: session.id, source, ...properties })).events;
    read('conversation.message.updated', {
      message: {
        id: 'msg_live',
        type: 'assistant',
        time: { created: 2 },
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'tool',
            id: 'call_shell',
            name: 'shell',
            state: { status: 'running', input: { command: 'pwd' } },
          },
        ],
      },
    });
    sourceReader.observeProjected([
      {
        info: {
          id: 'msg_live',
          sessionID: session.id,
          role: 'assistant',
          time: { created: 2 },
        } as MessageInfo,
        parts: [
          {
            id: 'msg_live_000000',
            sessionID: session.id,
            messageID: 'msg_live',
            type: 'text',
            text: 'before',
          },
        ],
      },
    ]);
    const events = read('conversation.event', {
      event: {
        id: 'evt_text_1',
        type: 'session.text.started',
        data: { sessionID: session.id, assistantMessageID: 'msg_live', ordinal: 1 },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'message.part.updated',
        part: expect.objectContaining({ id: 'msg_live_000002' }),
      }),
    ]);
  });

  it('rejects mismatched session identities and reports malformed native history entries', () => {
    const sourceReader = createConversationSourceReader();
    const reader = { read: (raw: CloudAgentEvent) => sourceReader.read(raw).events };
    expect(
      reader.read(
        wire('conversation.message.updated', { sessionID: 'ses_other', source, message: assistant })
      )
    ).toEqual([]);
    const display = cloudSessionMessagesPageSchema.parse({
      ...page,
      messages: [{ message: { id: 'invalid' } }, { message: user }],
    });
    expect(display?.omittedItemCount).toBe(1);
    expect(display?.messages).toHaveLength(1);
    expect(() =>
      cloudSessionMessagesPageSchema.parse({ ...page, info: { id: 'ses_other' } })
    ).toThrow('another session');
  });
  it('shows a stopped v2 turn as an interruption and other errors as failures', () => {
    const failed = (type: string) =>
      readKilo2Messages(session, [
        {
          id: `msg_${type}`,
          type: 'assistant',
          time: { created: 2, completed: 3 },
          error: { type, message: 'Assistant request failed' },
        },
      ])[0]?.info;
    expect(failed('aborted')).toMatchObject({ error: { name: 'MessageAbortedError' } });
    expect(failed('provider')).toMatchObject({
      error: { name: 'UnknownError', data: { message: 'Assistant request failed' } },
    });
  });
});

describe('native file result projection', () => {
  it.each(['read', 'mcp__fixture__image', 'shell', 'send_file'])(
    'preserves image/PDF results from %s once as ordinary files',
    name => {
      const message = kilo2MessageSchema.parse({
        id: 'msg_file_results',
        type: 'assistant',
        time: { created: 1, completed: 2 },
        content: [
          {
            type: 'tool',
            id: 'call_files',
            name,
            state: {
              status: 'completed',
              input: { path: 'document.pdf' },
              content: [
                { type: 'text', text: 'document result' },
                {
                  type: 'file',
                  uri: 'data:image/png;base64,AQID',
                  mime: 'image/png',
                  name: 'page.png',
                },
                {
                  type: 'file',
                  uri: 'data:application/pdf;base64,JVBERg==',
                  mime: 'application/pdf',
                  name: 'document.pdf',
                },
              ],
            },
          },
        ],
      });
      const projected = readKilo2Messages(session, [message]);
      expect(projected[0]?.parts[0]).toMatchObject({
        type: 'tool',
        state: {
          status: 'completed',
          output: 'document result',
        },
      });
      const tool = projected[0]?.parts[0];
      if (tool?.type !== 'tool' || tool.state.status !== 'completed') {
        throw new Error('Expected a completed tool result');
      }
      expect(tool.state).not.toHaveProperty('attachments');
      expect(projected[0]?.parts.slice(1)).toMatchObject([
        {
          id: kilo2ToolFileId(message.id, 0, 1),
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,AQID',
        },
        {
          id: kilo2ToolFileId(message.id, 0, 2),
          type: 'file',
          mime: 'application/pdf',
          url: 'data:application/pdf;base64,JVBERg==',
        },
      ]);
      expect(hasUnresolvedKilo2Assets(message)).toBe(false);
    }
  );

  it('keeps failure status while preserving files returned with an error', () => {
    const message = kilo2MessageSchema.parse({
      id: 'msg_error_files',
      type: 'assistant',
      time: { created: 1 },
      content: [
        {
          type: 'tool',
          id: 'call_error',
          name: 'read',
          state: {
            status: 'error',
            input: {},
            error: { type: 'partial', message: 'Partial result' },
            content: [{ type: 'file', uri: 'data:image/png;base64,AQID', mime: 'image/png' }],
          },
        },
      ],
    });
    expect(readKilo2Messages(session, [message])[0]?.parts).toMatchObject([
      { type: 'tool', state: { status: 'error', error: 'Partial result' } },
      {
        type: 'file',
        id: kilo2ToolFileId(message.id, 0, 0),
        mime: 'image/png',
        url: 'data:image/png;base64,AQID',
      },
    ]);
  });

  it('requires resolved private assets without fabricating inline data or using local paths as display URLs', () => {
    const hash = 'a'.repeat(64);
    const message = kilo2MessageSchema.parse({
      id: 'msg_stored_file',
      type: 'user',
      time: { created: 1 },
      text: 'inspect',
      files: [{ mime: 'image/png', uri: `media:${hash}`, source: { type: 'inline' } }],
    });
    const id = kilo2PartId(message.id, 1);
    expect(hasUnresolvedKilo2Assets(message)).toBe(true);
    expect(() => readKilo2Messages(session, [message])).toThrow('authorized asset resolution');
    const assetURLs = {
      [kilo2AssetKey(id, `media:${hash}`, 'image/png')]: 'data:image/png;base64,AQID',
    };
    expect(hasUnresolvedKilo2Assets(message, assetURLs)).toBe(false);
    expect(readKilo2Messages(session, [message], { assetURLs })[0]?.parts[1]).toMatchObject({
      id,
      type: 'file',
      url: 'data:image/png;base64,AQID',
    });
    expect(message.files?.[0]).not.toHaveProperty('data');
    const replaced = kilo2MessageSchema.parse({
      ...message,
      files: [{ mime: 'image/png', uri: `media:${'b'.repeat(64)}`, source: { type: 'inline' } }],
    });
    expect(hasUnresolvedKilo2Assets(replaced, assetURLs)).toBe(true);
    expect(() => readKilo2Messages(session, [replaced], { assetURLs })).toThrow(
      'authorized asset resolution'
    );
    const retyped = kilo2MessageSchema.parse({
      ...message,
      files: [{ mime: 'application/pdf', uri: `media:${hash}`, source: { type: 'inline' } }],
    });
    expect(hasUnresolvedKilo2Assets(retyped, assetURLs)).toBe(true);
    expect(() => readKilo2Messages(session, [retyped], { assetURLs })).toThrow(
      'authorized asset resolution'
    );

    const tool = kilo2MessageSchema.parse({
      id: 'msg_local_file',
      type: 'assistant',
      time: { created: 1 },
      content: [
        {
          type: 'tool',
          id: 'call_local',
          name: 'read',
          state: {
            status: 'completed',
            input: {},
            content: [{ type: 'file', uri: 'file:///synthetic/private.png', mime: 'image/png' }],
          },
        },
      ],
    });
    expect(hasUnresolvedKilo2Assets(tool)).toBe(true);
    expect(() => readKilo2Messages(session, [tool])).toThrow('authorized asset resolution');
  });
});

it.each(['completed', 'error'])(
  'retains seeded native text positions beside derivative files from %s tools',
  status => {
    const message = kilo2MessageSchema.parse({
      id: 'msg_seeded_error_file',
      type: 'assistant',
      time: { created: 1 },
      content: [
        {
          type: 'tool',
          id: 'call_error',
          name: 'read',
          state: {
            status,
            input: {},
            ...(status === 'error'
              ? { error: { type: 'partial', message: 'Partial result' } }
              : {}),
            content: [{ type: 'file', uri: 'data:image/png;base64,AQID', mime: 'image/png' }],
          },
        },
        { type: 'text', text: 'existing' },
      ],
    });
    const reader = createConversationSourceReader();
    reader.observeProjected(readKilo2Messages(session, [message]));
    const events = reader.read(
      wire('conversation.event', {
        sessionID: session.id,
        source: { version: 'v2' },
        event: {
          id: 'evt_seeded_error_file',
          type: 'session.text.delta',
          data: {
            sessionID: session.id,
            assistantMessageID: message.id,
            ordinal: 0,
            delta: '!',
          },
        },
      })
    ).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'message.part.delta', partId: kilo2PartId(message.id, 1) }),
    ]);
  }
);
