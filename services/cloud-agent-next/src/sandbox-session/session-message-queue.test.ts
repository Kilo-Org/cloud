import { describe, expect, it } from 'vitest';
import {
  acceptQueuedMessage,
  assignPreparationAttemptId,
  cancelActiveMessages,
  failQueuedMessage,
  hasAcceptedMessage,
  hasInterruptibleWork,
  nextQueuedMessageId,
  recordAcceptedMessageActivity,
  streamCloudStatus,
  streamQueuedSnapshots,
  terminalizeAcceptedMessages,
  userTurnTerminalState,
  type SessionMessageRecord,
} from './session-message-queue.js';

function msg(messageId: string, state: SessionMessageRecord['state']): SessionMessageRecord {
  return { messageId, state };
}

describe('nextQueuedMessageId', () => {
  it('returns the oldest queued message when none are accepted', () => {
    expect(
      nextQueuedMessageId([msg('a', 'completed'), msg('b', 'queued'), msg('c', 'queued')])
    ).toBe('b');
  });

  it('returns undefined while a message is accepted', () => {
    expect(nextQueuedMessageId([msg('a', 'accepted'), msg('b', 'queued')])).toBeUndefined();
  });

  it('returns undefined when the queue is empty', () => {
    expect(nextQueuedMessageId([msg('a', 'completed')])).toBeUndefined();
  });
});

describe('assignPreparationAttemptId', () => {
  it('returns undefined when the message is missing', () => {
    expect(assignPreparationAttemptId([msg('a', 'queued')], 'missing', () => 'attempt-1')).toBe(
      undefined
    );
  });

  it('reuses an existing id and preserves the array identity', () => {
    const messages = [{ ...msg('a', 'queued'), preparationAttemptId: 'attempt-1' }];

    const assigned = assignPreparationAttemptId(messages, 'a', () => 'attempt-2');

    expect(assigned?.attemptId).toBe('attempt-1');
    expect(assigned?.messages).toBe(messages);
  });

  it('mints an id and stores it only on the matching message', () => {
    const messages = [msg('a', 'queued'), msg('b', 'queued')];

    const assigned = assignPreparationAttemptId(messages, 'b', () => 'attempt-1');

    expect(assigned?.attemptId).toBe('attempt-1');
    expect(assigned?.messages).not.toBe(messages);
    expect(assigned?.messages).toEqual([
      msg('a', 'queued'),
      { ...msg('b', 'queued'), preparationAttemptId: 'attempt-1' },
    ]);
  });
});

describe('userTurnTerminalState', () => {
  it('maps session.turn.close and session.error only', () => {
    expect(userTurnTerminalState('session.turn.close')).toBe('completed');
    expect(userTurnTerminalState('session.error')).toBe('failed');
    expect(userTurnTerminalState('session.idle')).toBeUndefined();
    expect(userTurnTerminalState('message.updated')).toBeUndefined();
  });

  it.each([
    ['session.turn.close', 'completed'],
    ['session.error', 'failed'],
  ])('settles %s only for the root session', (type, state) => {
    expect(userTurnTerminalState(type, 'root', 'root')).toBe(state);
    expect(userTurnTerminalState(type, 'child', 'root')).toBeUndefined();
    expect(userTurnTerminalState(type, undefined, 'root')).toBe(state);
  });
});

describe('terminalizeAcceptedMessages', () => {
  it('completes only accepted messages and leaves queued intact', () => {
    const next = terminalizeAcceptedMessages(
      [msg('a', 'accepted'), msg('b', 'queued'), msg('c', 'completed')],
      'completed'
    );
    expect(next.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'completed'],
      ['b', 'queued'],
      ['c', 'completed'],
    ]);
    expect(hasAcceptedMessage(next)).toBe(false);
  });
});

describe('cancelActiveMessages', () => {
  it('cancels queued and accepted messages and leaves terminals intact', () => {
    const { messages, cancelledIds } = cancelActiveMessages([
      msg('a', 'accepted'),
      msg('b', 'queued'),
      msg('c', 'completed'),
      msg('d', 'failed'),
    ]);
    expect(messages.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'cancelled'],
      ['b', 'cancelled'],
      ['c', 'completed'],
      ['d', 'failed'],
    ]);
    expect(cancelledIds).toEqual(['a', 'b']);
  });
});

describe('failQueuedMessage', () => {
  it('fails only the matching queued message', () => {
    const next = failQueuedMessage([msg('a', 'queued'), msg('b', 'queued')], 'a');
    expect(next?.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'failed'],
      ['b', 'queued'],
    ]);
  });

  it('does not change an already terminal message', () => {
    expect(failQueuedMessage([msg('a', 'completed')], 'a')).toBeUndefined();
    expect(failQueuedMessage([msg('a', 'accepted')], 'a')).toBeUndefined();
  });
});

describe('acceptQueuedMessage', () => {
  it('accepts only the next queued message', () => {
    const accepted = acceptQueuedMessage([msg('a', 'queued'), msg('b', 'queued')], 'a', 10);
    expect(accepted?.map(message => [message.messageId, message.state])).toEqual([
      ['a', 'accepted'],
      ['b', 'queued'],
    ]);
    expect(accepted?.find(message => message.messageId === 'a')).toEqual({
      messageId: 'a',
      state: 'accepted',
      acceptedAt: 10,
      lastActivityAt: 10,
    });
  });

  it('preserves structured prompt attachments and command arguments', () => {
    const prompt = {
      type: 'prompt' as const,
      messageId: 'a',
      prompt: 'inspect attachment',
      attachments: { path: 'attachment-path', files: ['document.pdf'] },
    };
    const command = {
      type: 'command' as const,
      messageId: 'b',
      command: 'review',
      arguments: '--all changes',
    };

    expect(
      acceptQueuedMessage([{ messageId: 'a', state: 'queued', turn: prompt }], 'a', 10)?.[0]
    ).toMatchObject({ state: 'accepted', turn: prompt });
    expect(
      acceptQueuedMessage([{ messageId: 'b', state: 'queued', turn: command }], 'b', 20)?.[0]
    ).toMatchObject({ state: 'accepted', turn: command });
  });

  it('does not resurrect a cancelled message after interrupt', () => {
    expect(
      acceptQueuedMessage([msg('a', 'cancelled'), msg('b', 'queued')], 'a', 10)
    ).toBeUndefined();
  });

  it('does not accept while another message is accepted', () => {
    expect(
      acceptQueuedMessage([msg('a', 'accepted'), msg('b', 'queued')], 'b', 10)
    ).toBeUndefined();
  });
});

const nonterminalSessionEventTypes = ['session.event', 'message.part.delta', 'session.idle'];

describe('recordAcceptedMessageActivity', () => {
  it.each(nonterminalSessionEventTypes)(
    'keeps the accepted turn active when a %s event arrives',
    eventType => {
      expect(userTurnTerminalState(eventType)).toBeUndefined();

      const messages: SessionMessageRecord[] = [
        { messageId: 'a', state: 'accepted', acceptedAt: 10, lastActivityAt: 20 },
        { messageId: 'b', state: 'queued' },
        { messageId: 'c', state: 'completed' },
      ];

      expect(recordAcceptedMessageActivity(messages, 30)).toEqual([
        { messageId: 'a', state: 'accepted', acceptedAt: 10, lastActivityAt: 30 },
        { messageId: 'b', state: 'queued' },
        { messageId: 'c', state: 'completed' },
      ]);
    }
  );

  it.each(['session.turn.close', 'session.error'])(
    'keeps the parent active and the next turn queued for a child %s',
    eventType => {
      const messages: SessionMessageRecord[] = [
        { messageId: 'parent', state: 'accepted', acceptedAt: 10, lastActivityAt: 20 },
        { messageId: 'next', state: 'queued' },
      ];

      expect(userTurnTerminalState(eventType, 'child', 'root')).toBeUndefined();
      const activeMessages = recordAcceptedMessageActivity(messages, 30);

      expect(activeMessages).toEqual([
        { messageId: 'parent', state: 'accepted', acceptedAt: 10, lastActivityAt: 30 },
        { messageId: 'next', state: 'queued' },
      ]);
      expect(nextQueuedMessageId(activeMessages ?? [])).toBeUndefined();
    }
  );

  it('does not update messages when no turn is accepted', () => {
    expect(
      recordAcceptedMessageActivity([msg('a', 'queued'), msg('b', 'completed')], 30)
    ).toBeUndefined();
  });
});

describe('hasInterruptibleWork', () => {
  it('is true for queued, accepted, or already-cancelled messages', () => {
    expect(hasInterruptibleWork([msg('a', 'completed')])).toBe(false);
    expect(hasInterruptibleWork([msg('a', 'queued')])).toBe(true);
    expect(hasInterruptibleWork([msg('a', 'cancelled')])).toBe(true);
  });
});

describe('streamQueuedSnapshots', () => {
  it('surfaces queued and accepted legacy prompts for /stream catch-up', () => {
    expect(
      streamQueuedSnapshots(
        [
          { messageId: 'a', state: 'queued', prompt: 'hello' },
          { messageId: 'b', state: 'accepted', prompt: 'world', acceptedAt: 20 },
          { messageId: 'c', state: 'completed', prompt: 'done' },
        ],
        99
      )
    ).toEqual([
      { messageId: 'a', content: 'hello', timestamp: 99 },
      { messageId: 'b', content: 'world', timestamp: 20 },
    ]);
  });

  it('renders structured prompts and commands for queued-message reconnect', () => {
    expect(
      streamQueuedSnapshots(
        [
          {
            messageId: 'a',
            state: 'accepted',
            acceptedAt: 20,
            turn: { type: 'prompt', messageId: 'a', prompt: 'hello' },
          },
          {
            messageId: 'b',
            state: 'queued',
            turn: { type: 'command', messageId: 'b', command: 'review', arguments: '--all' },
          },
          {
            messageId: 'c',
            state: 'queued',
            turn: { type: 'command', messageId: 'c', command: 'status', arguments: '' },
          },
        ],
        99
      )
    ).toEqual([
      { messageId: 'a', content: 'hello', timestamp: 20 },
      { messageId: 'b', content: '/review --all', timestamp: 99 },
      { messageId: 'c', content: '/status', timestamp: 99 },
    ]);
  });
});

describe('streamCloudStatus', () => {
  it('is preparing while work is queued or accepted', () => {
    expect(streamCloudStatus([msg('a', 'queued')])).toEqual({ type: 'preparing' });
    expect(streamCloudStatus([msg('a', 'accepted')])).toEqual({ type: 'preparing' });
  });

  it('is ready after a turn and null before any messages', () => {
    expect(streamCloudStatus([msg('a', 'completed')])).toEqual({ type: 'ready' });
    expect(streamCloudStatus([])).toBeNull();
  });
});
