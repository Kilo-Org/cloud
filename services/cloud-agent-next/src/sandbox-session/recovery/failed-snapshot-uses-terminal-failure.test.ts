import { describe, expect, it } from 'vitest';
import { failWaitingMessages, streamQueuedSnapshots } from '../session-message-queue.js';

describe('failed snapshot', () => {
  it('projects failed rows with terminalFailure instead of as queued', () => {
    const { messages } = failWaitingMessages(
      [
        { messageId: 'a', state: 'queued', prompt: 'hello' },
        { messageId: 'b', state: 'accepted', prompt: 'world', acceptedAt: 20 },
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
          timestamp: 20,
        },
      },
    ]);
    expect(snapshots.every(snapshot => snapshot.terminalFailure !== undefined)).toBe(true);
  });
});
