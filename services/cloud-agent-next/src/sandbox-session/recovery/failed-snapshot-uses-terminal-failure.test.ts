import { describe, expect, it } from 'vitest';
import {
  failWaitingMessages,
  failedMessageSnapshot,
  failedReasonOf,
  streamQueuedSnapshots,
} from '../session-message-queue.js';
import { acceptedMessage, queuedMessage } from '../session-state.test-helpers.js';

function promptIntent(prompt: string) {
  return {
    turn: { type: 'prompt' as const, messageId: 'intent', prompt },
    agent: { mode: 'code' as const },
  };
}

describe('failed snapshot', () => {
  it('projects failed messages with terminalFailure instead of as queued', () => {
    const { messages } = failWaitingMessages(
      [
        queuedMessage('a', { intent: promptIntent('hello') }),
        acceptedMessage('b', { intent: promptIntent('world'), acceptedAt: 20 }),
      ],
      'environment_failed'
    );
    const snapshots = streamQueuedSnapshots(messages, 99);
    expect(snapshots).toEqual([
      {
        messageId: 'a',
        content: 'hello',
        timestamp: 99,
        terminalFailure: {
          messageId: 'a',
          status: 'failed',
          delivery: 'queued',
          accepted: false,
          reason: 'environment_failed',
          error: 'environment_failed',
          timestamp: 99,
        },
      },
      {
        messageId: 'b',
        content: 'world',
        timestamp: 20,
        terminalFailure: {
          messageId: 'b',
          status: 'failed',
          delivery: 'sent',
          accepted: true,
          reason: 'environment_failed',
          error: 'environment_failed',
          timestamp: 20,
        },
      },
    ]);
    expect(snapshots.every(snapshot => snapshot.terminalFailure !== undefined)).toBe(true);
  });

  it('settles a confirmed cancellation as interrupted, never the internal retirement reason', () => {
    const { messages } = failWaitingMessages(
      [
        acceptedMessage(
          'a',
          { acceptedAt: 20 },
          { cancellation: { operationId: 'op', deadlineAt: 30 } }
        ),
      ],
      'Scoped Stop cleanup'
    );
    expect(messages[0]?.state.kind).toBe('cancelled');
    expect(failedReasonOf(messages[0]!)).toBeUndefined();
    const payload = failedMessageSnapshot(messages[0]!, 99);
    expect(payload).toEqual({
      messageId: 'a',
      status: 'interrupted',
      delivery: 'sent',
      accepted: true,
      reason: 'interrupted',
      error: 'The message was interrupted',
      timestamp: 20,
    });
    expect(JSON.stringify(payload)).not.toContain('Scoped Stop cleanup');
  });

  it('cannot leak an internal failure reason once the client contract is decided', () => {
    const { messages, failedIds } = failWaitingMessages(
      [
        acceptedMessage(
          'a',
          { acceptedAt: 20 },
          { cancellation: { operationId: 'op', deadlineAt: 30 } }
        ),
      ],
      'runtime_unhealthy'
    );
    expect(messages[0]?.state.kind).toBe('cancelled');
    expect(failedIds).toEqual(['a']);
    expect(failedReasonOf(messages[0]!)).toBeUndefined();
    const payload = failedMessageSnapshot(messages[0]!, 99);
    expect(payload).toEqual({
      messageId: 'a',
      status: 'interrupted',
      delivery: 'sent',
      accepted: true,
      reason: 'interrupted',
      error: 'The message was interrupted',
      timestamp: 20,
    });
    expect(JSON.stringify(payload)).not.toContain('runtime_unhealthy');
  });
});
