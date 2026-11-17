import { readKilo2Messages } from './kilo2-source-messages';
import { applyNativeEvent } from './native-conversation-reducer';
import { readNativeConversation } from './native-conversation-source';
import type { NativeEvent, NativeSessionState } from './native-sync';
import { cloudSessionMessagesPageSchema } from './schemas';

const session = {
  id: 'ses_instructions',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
};

function notification() {
  return {
    id: 'msg_instructions',
    type: 'synthetic',
    time: { created: 3 },
    description: 'Loaded services/AGENTS.md',
    text: 'Instructions from: /workspace/app/services/AGENTS.md\n# Services\nUse the service conventions.',
    metadata: { instruction: { paths: ['/workspace/app/services/AGENTS.md'] } },
  };
}

test('loaded instructions become a neutral agent notice without changing native history', () => {
  const native = notification();
  const original = structuredClone(native);
  const display = readKilo2Messages(session, [native])[0];

  expect(display?.info).toMatchObject({ role: 'assistant', time: { created: 3, completed: 3 } });
  expect(display?.parts).toEqual([
    expect.objectContaining({
      type: 'tool',
      tool: 'agent_notice',
      state: expect.objectContaining({
        status: 'completed',
        output: native.text,
        metadata: expect.objectContaining({
          instruction: native.metadata.instruction,
          backgroundResult: {
            kind: 'notice',
            state: 'unknown',
            outcome: 'unknown',
            description: native.description,
            output: native.text,
          },
        }),
      }),
    }),
  ]);
  expect(native).toEqual(original);
});

test('instruction text and metadata on an actual user message remain user input', () => {
  const native = { ...notification(), type: 'user' };
  const display = readKilo2Messages(session, [native])[0];

  expect(display?.info.role).toBe('user');
  expect(display?.parts[0]).toMatchObject({ type: 'text', text: native.text });
});

test('persisted Cloud history uses the same instruction notice as live projection', () => {
  const native = notification();
  const page = cloudSessionMessagesPageSchema.parse({
    kind: 'success',
    info: { id: session.id, title: 'Instruction notice test' },
    source: { version: 'v2', session },
    messages: [{ message: native, parentID: 'msg_user' }],
    nextCursor: null,
    omittedItemCount: 0,
    updateCursor: 1,
  });

  expect(page?.omittedItemCount).toBe(0);
  expect(page?.messages[0]?.info).toMatchObject({ role: 'assistant', parentID: 'msg_user' });
  expect(page?.messages[0]?.parts).toEqual(readKilo2Messages(session, [native])[0]?.parts);
});

test.each(['callback', 'review', 'wakeup', 'queued', 'optimistic'])(
  'preserves the %s prompt classification even with instruction metadata',
  source => {
    const native = notification();
    const display = readKilo2Messages(session, [
      { ...native, metadata: { ...native.metadata, source } },
    ])[0];

    expect(display?.info.role).toBe('user');
  }
);

test('multiple instruction paths stay in one notice and do not replace the user turn parent', () => {
  const native = notification();
  const display = readKilo2Messages(session, [
    { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'Read the service' },
    {
      ...native,
      metadata: {
        instruction: {
          paths: ['/workspace/app/services/AGENTS.md', '/workspace/app/services/worker/AGENTS.md'],
        },
      },
    },
    { id: 'msg_answer', type: 'assistant', time: { created: 4, completed: 5 }, content: [] },
  ]);

  expect(display.map(message => message.info.role)).toEqual(['user', 'assistant', 'assistant']);
  expect(display[2]?.info).toMatchObject({ parentID: 'msg_user' });
});

test('live instruction events and reloaded snapshots have the same notice and preserve raw instructions', () => {
  const native = notification();
  const event: NativeEvent = {
    v: 1,
    channel: 'events',
    seq: 3,
    from: 'runner',
    at: 3,
    type: 'session.synthetic',
    body: {
      syncPosition: 3,
      data: {
        id: 'evt_instructions',
        type: 'session.synthetic',
        created: 3,
        data: {
          sessionID: session.id,
          text: native.text,
          description: native.description,
          metadata: native.metadata,
        },
      },
    },
  };
  const state: NativeSessionState = {
    session: { ...session, origin: session.location },
    snapshot: { position: 3, revision: 1 },
    messages: applyNativeEvent([], event),
    connection: 'connected',
    runnerConnected: true,
    events: [],
    pending: { permissions: [], questions: [], unreadablePermissions: [] },
    commands: {},
  };
  const live = readNativeConversation(state);
  const reloaded = readNativeConversation({ ...state, messages: [{ seq: 3, message: native }] });

  expect(live.messages).toEqual(reloaded.messages);
  expect(live.messages[0]?.info.role).toBe('assistant');
  expect(live.nativeMessages[0]?.message).toMatchObject(native);
  expect(reloaded.nativeMessages[0]?.message).toBe(native);
});
