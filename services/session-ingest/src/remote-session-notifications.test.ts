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
  it.each(['vscode', 'agent-manager'])('is eligible for a root %s session', createdOnPlatform => {
    expect(isEligibleForRemoteSessionAttention({ parentSessionId: null, createdOnPlatform })).toBe(
      true
    );
  });

  it('is not eligible for a child session', () => {
    expect(
      isEligibleForRemoteSessionAttention({
        parentSessionId: 'parent-1',
        createdOnPlatform: 'vscode',
      })
    ).toBe(false);
  });

  it.each([null, 'cli', 'cloud-agent-web'])(
    'is not eligible for a root session created on %s',
    createdOnPlatform => {
      expect(
        isEligibleForRemoteSessionAttention({ parentSessionId: null, createdOnPlatform })
      ).toBe(false);
    }
  );
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
  it('sends a push with a stable executionId and web-viewing suppression flag', async () => {
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      { kiloUserId: 'usr_1', sessionId: 'ses_1', signal: completedSignal('Done') },
      { hasActiveCliSession: async () => true, sendPush }
    );

    expect(outcome).toBe('sent');
    expect(sendPush).toHaveBeenCalledWith({
      userId: 'usr_1',
      cliSessionId: 'ses_1',
      executionId: 'remote:msg-1',
      status: 'completed',
      body: 'Done',
      suppressIfViewingSession: true,
    });
  });

  it('suppresses the push when no connected CLI reports the session', async () => {
    const hasActiveCliSession = vi.fn(async () => false);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      { kiloUserId: 'usr_1', sessionId: 'ses_1', signal: completedSignal('Done') },
      { hasActiveCliSession, sendPush }
    );

    expect(outcome).toBe('suppressed');
    expect(hasActiveCliSession).toHaveBeenCalledOnce();
    expect(sendPush).not.toHaveBeenCalled();
  });
});
