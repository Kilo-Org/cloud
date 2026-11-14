import { describe, expect, it } from 'vitest';
import { renderQueuedMessageContent, type SessionMessage } from './messages.js';

describe('renderQueuedMessageContent', () => {
  const message = {
    messageId: 'msg_command',
    intent: {
      messageId: 'msg_command',
      agent: { mode: 'code', model: 'kilo/fake-deterministic' },
      turn: { type: 'command', command: 'review', arguments: 'main' },
    },
    state: 'queued',
    createdAt: 1,
    acceptedAt: null,
    settledAt: null,
    reason: null,
  } satisfies SessionMessage;

  it.each(['queued', 'failed'] as const)('retains unaccepted %s command text', state => {
    expect(renderQueuedMessageContent({ ...message, state })).toBe('/review main');
  });

  it('renders a command without arguments', () => {
    expect(
      renderQueuedMessageContent({
        ...message,
        intent: { ...message.intent, turn: { type: 'command', command: 'review', arguments: '' } },
      })
    ).toBe('/review');
  });

  it.each(['accepted', 'failed'] as const)('omits accepted %s command text', state => {
    expect(renderQueuedMessageContent({ ...message, state, acceptedAt: 2 })).toBe('');
  });

  it.each(['Review the changes', '/not-a-command main'])('preserves prompt text %j', prompt => {
    expect(
      renderQueuedMessageContent({
        ...message,
        intent: { ...message.intent, turn: { type: 'prompt', prompt } },
      })
    ).toBe(prompt);
  });
});
