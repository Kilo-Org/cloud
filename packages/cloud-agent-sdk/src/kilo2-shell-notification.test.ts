import { readKilo2Messages } from './kilo2-source-messages';
import { applyNativeEvent } from './native-conversation-reducer';
import { readNativeConversation } from './native-conversation-source';
import type { NativeEvent, NativeSessionState } from './native-sync';
import { projectKilo2ShellNotification } from './kilo2-shell-notification';

const session = {
  id: 'ses_shell',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
};

function notification(
  exit = 0,
  command = 'printf background-output',
  output = 'background-output'
) {
  return {
    id: 'msg_shell_completion',
    type: 'synthetic',
    time: { created: 3 },
    description: command,
    text: `<shell id="sh_background" state="completed" command="${command}">\n${output}\n</shell>`,
    metadata: {
      source: 'shell',
      shellID: 'sh_background',
      jobID: 'sh_background',
      state: 'completed',
      exit,
      truncated: false,
    },
  };
}

test('shell completions become completed assistant command cards, not user messages or raw markup', () => {
  const native = notification();
  const original = structuredClone(native);
  const display = readKilo2Messages(session, [native])[0];
  expect(display?.info).toMatchObject({ role: 'assistant', time: { created: 3, completed: 3 } });
  expect(display?.parts).toEqual([
    expect.objectContaining({
      type: 'tool',
      tool: 'bash',
      state: expect.objectContaining({
        status: 'completed',
        input: { command: native.description, description: 'Background command completed' },
        output: 'background-output',
        metadata: native.metadata,
      }),
    }),
  ]);
  expect(native).toEqual(original);
});

test.each([1, 130])('nonzero shell exit %i is a command error, not a session failure', exit => {
  const native = notification(exit, 'test-command', 'diagnostic output');
  const display = readKilo2Messages(session, [native])[0];
  expect(display?.info).not.toHaveProperty('error');
  expect(display?.parts[0]).toMatchObject({
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'error',
      error: `diagnostic output\n\nCommand exited with code ${exit}`,
      metadata: { exit },
    },
  });
});

test('keeps multiline commands, quotes, redirects, and shell-like output intact', () => {
  const command = 'printf "a > b"\nprintf second';
  const output = 'first\n<shell>literal output</shell>\nlast\n';
  const display = readKilo2Messages(session, [notification(0, command, output)])[0];
  expect(display?.parts[0]).toMatchObject({ state: { input: { command }, output } });
});

test('handles a completed command with no output', () => {
  const display = readKilo2Messages(session, [notification(0, 'true', '')])[0];
  expect(display?.parts[0]).toMatchObject({ state: { status: 'completed', output: '' } });
});

test('shows a stopped command without an exit code as a command error', () => {
  const native = notification();
  const stopped = {
    ...native,
    text: native.text.replace('state="completed"', 'state="killed"'),
    metadata: { ...native.metadata, state: 'killed', exit: undefined },
  };
  expect(readKilo2Messages(session, [stopped])[0]?.parts[0]).toMatchObject({
    state: { status: 'error', error: 'background-output\n\nBackground command killed' },
  });
});

test('does not reinterpret user text, other synthetic messages, or malformed notifications', () => {
  const native = notification();
  for (const message of [
    { ...native, type: 'user' },
    { ...native, metadata: { ...native.metadata, source: 'other' } },
    { ...native, metadata: undefined },
    { ...native, description: undefined },
    { ...native, text: 'Not a shell notification envelope' },
  ]) {
    expect(projectKilo2ShellNotification(message)).toBe(message);
    expect(readKilo2Messages(session, [message])[0]?.info.role).toBe('user');
  }
});

test('native live events and reloaded snapshots use the same display while preserving raw history', () => {
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
        id: native.id.replace(/^msg_/, 'evt_'),
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
    pending: { permissions: [], questions: [] },
    commands: {},
  };
  const live = readNativeConversation(state);
  const reloaded = readNativeConversation({ ...state, messages: [{ seq: 3, message: native }] });
  expect(live.messages).toEqual(reloaded.messages);
  expect(live.messages[0]?.info.role).toBe('assistant');
  expect(live.nativeMessages[0]?.message).toMatchObject(native);
  expect(reloaded.nativeMessages[0]?.message.text).toBe(native.text);
});
