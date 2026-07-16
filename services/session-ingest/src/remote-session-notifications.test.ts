import { describe, it, expect, vi } from 'vitest';
import type { AttentionSignal } from './dos/session-ingest-attention';
import {
  buildRemoteSessionAttentionPushBody,
  dispatchRemoteSessionAttentionSignal,
  isEligibleForRemoteSessionAttention,
} from './remote-session-notifications';

function completedSignal(messageExcerpt: string): AttentionSignal {
  return { signalId: 'msg-1', kind: 'completed', messageExcerpt };
}

function needsInputSignal(): AttentionSignal {
  return { signalId: 'status:question:123', kind: 'needs_input', messageExcerpt: '' };
}

describe('isEligibleForRemoteSessionAttention', () => {
  it('is eligible for a root session', () => {
    expect(isEligibleForRemoteSessionAttention({ parentSessionId: null })).toBe(true);
  });

  it('is not eligible for a child session', () => {
    expect(isEligibleForRemoteSessionAttention({ parentSessionId: 'parent-1' })).toBe(false);
  });
});

describe('buildRemoteSessionAttentionPushBody', () => {
  it('uses the message excerpt for a completed signal', () => {
    expect(buildRemoteSessionAttentionPushBody(completedSignal('All done!'))).toBe('All done!');
  });

  it('falls back to a default body when the excerpt is empty', () => {
    expect(buildRemoteSessionAttentionPushBody(completedSignal(''))).toBe('Task completed');
  });

  it('uses a fixed body for needs-input signals', () => {
    expect(buildRemoteSessionAttentionPushBody(needsInputSignal())).toBe('Kilo needs your input.');
  });
});

describe('dispatchRemoteSessionAttentionSignal', () => {
  it('dispatches the push when enabled and the CLI reports an active session', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      { kiloUserId: 'usr_1', sessionId: 'ses_1', signal: completedSignal('Done') },
      { hasActiveCliSession, sendPush }
    );

    expect(outcome).toBe('sent');
    expect(hasActiveCliSession).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledWith({
      userId: 'usr_1',
      cliSessionId: 'ses_1',
      executionId: 'remote:msg-1',
      status: 'completed',
      body: 'Done',
      suppressIfViewingSession: true,
    });
  });

  it('suppresses the push when the CLI has no active heartbeat, even with the flag enabled', async () => {
    const hasActiveCliSession = vi.fn(async () => false);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      { kiloUserId: 'usr_1', sessionId: 'ses_1', signal: completedSignal('Done') },
      { hasActiveCliSession, sendPush }
    );

    expect(outcome).toBe('suppressed');
    expect(hasActiveCliSession).toHaveBeenCalledTimes(1);
    expect(sendPush).not.toHaveBeenCalled();
  });
});
