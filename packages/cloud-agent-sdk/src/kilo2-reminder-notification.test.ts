import { readKilo2Messages } from './kilo2-source-messages';
import { applyNativeEvent } from './native-conversation-reducer';
import { readNativeConversation } from './native-conversation-source';
import type { NativeEvent, NativeSessionState } from './native-sync';

const session = {
  id: 'ses_reminder',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
};

const agentSwitchReminder = `<system-reminder>
The active agent has changed from dev to Code.
This supersedes earlier agent-switch reminders. Your instructions and permissions are those of the Code agent as given in the current system prompt; earlier turns reflect the previous agent, not your current capabilities.
This agent may modify files and run commands within its configured permissions.
</system-reminder>`;

const reminderBody = agentSwitchReminder
  .replace(/^<system-reminder>\n/, '')
  .replace(/\n<\/system-reminder>$/, '');

function reminder(text: string) {
  return { id: 'msg_reminder', type: 'synthetic', time: { created: 3 }, text };
}

test('an agent-switch reminder becomes a neutral agent notice without changing native history', () => {
  const native = reminder(agentSwitchReminder);
  const original = structuredClone(native);
  const display = readKilo2Messages(session, [native])[0];

  expect(display?.info).toMatchObject({ role: 'assistant', time: { created: 3, completed: 3 } });
  expect(display?.parts).toEqual([
    expect.objectContaining({
      type: 'tool',
      tool: 'agent_notice',
      state: expect.objectContaining({
        status: 'completed',
        output: reminderBody,
        metadata: expect.objectContaining({
          backgroundResult: {
            kind: 'notice',
            state: 'unknown',
            outcome: 'unknown',
            description: 'The active agent has changed from dev to Code.',
            output: reminderBody,
          },
        }),
      }),
    }),
  ]);
  expect(native).toEqual(original);
});

test('reminder text on an actual user message remains user input', () => {
  const native = { ...reminder(agentSwitchReminder), type: 'user' };
  const display = readKilo2Messages(session, [native])[0];

  expect(display?.info.role).toBe('user');
  expect(display?.parts[0]).toMatchObject({ type: 'text', text: agentSwitchReminder });
});

test('a prompt with an appended reminder stays user content', () => {
  const native = reminder(`fix the tests\n\n${agentSwitchReminder}`);
  const display = readKilo2Messages(session, [native])[0];

  expect(display?.info.role).toBe('user');
  expect(display?.parts[0]).toMatchObject({ type: 'text', text: native.text });
});

test('a plan-mode reminder becomes the same neutral notice', () => {
  const text =
    '<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly.\n</system-reminder>';
  const display = readKilo2Messages(session, [reminder(text)])[0];

  expect(display?.info.role).toBe('assistant');
  expect(display?.parts[0]).toMatchObject({
    type: 'tool',
    tool: 'agent_notice',
    state: expect.objectContaining({
      output: 'You are in Plan mode. Discuss the plan with the user directly.',
      metadata: expect.objectContaining({
        backgroundResult: expect.objectContaining({
          description: 'You are in Plan mode. Discuss the plan with the user directly.',
        }),
      }),
    }),
  });
});

test('multiple reminder blocks in one synthetic message stay in one notice', () => {
  const text = `${agentSwitchReminder}\n\n<system-reminder>\nNote: the user opened a file.\n</system-reminder>`;
  const display = readKilo2Messages(session, [reminder(text)])[0];

  expect(display?.info.role).toBe('assistant');
  expect(display?.parts).toHaveLength(1);
  expect(display?.parts[0]).toMatchObject({
    type: 'tool',
    tool: 'agent_notice',
    state: expect.objectContaining({
      output: `${reminderBody}\n\nNote: the user opened a file.`,
    }),
  });
});

test('the reminder notice does not replace the user turn parent', () => {
  const display = readKilo2Messages(session, [
    { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'continue' },
    reminder(agentSwitchReminder),
    { id: 'msg_answer', type: 'assistant', time: { created: 4, completed: 5 }, content: [] },
  ]);

  expect(display.map(message => message.info.role)).toEqual(['user', 'assistant', 'assistant']);
  expect(display[2]?.info).toMatchObject({ parentID: 'msg_user' });
});

test.each(['callback', 'review', 'wakeup', 'queued', 'optimistic'])(
  'preserves the %s prompt classification even with reminder-only text',
  source => {
    const native = { ...reminder(agentSwitchReminder), metadata: { source } };
    const display = readKilo2Messages(session, [native])[0];

    expect(display?.info.role).toBe('user');
  }
);

test('live reminder events and reloaded snapshots have the same notice and preserve raw text', () => {
  const native = reminder(agentSwitchReminder);
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
        id: 'evt_reminder',
        type: 'session.synthetic',
        created: 3,
        data: { sessionID: session.id, text: native.text },
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
  expect(live.nativeMessages[0]?.message).toMatchObject({ type: 'synthetic', text: native.text });
  expect(reloaded.nativeMessages[0]?.message).toBe(native);
});
