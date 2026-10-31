import { createConversationSourceReader } from './conversation-source';
import { cloudSessionMessagesPageSchema, cloudSessionMessagesPageWireSchema } from './schemas';
import type { CloudAgentEvent } from './cloud-conversation-schemas';

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
        partId: `${assistant.id}_text_0`,
        field: 'text',
        delta: 'chunk',
      },
    ]);
    reader.read(
      wire('conversation.message.updated', { sessionID: session.id, source, message: assistant })
    );
    expect(reader.read(raw)).toEqual([]);
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
});
