import { describe, it, expect, vi } from 'vitest';
import type { AttentionSignal } from './dos/session-ingest-attention';
import {
  buildRemoteSessionAttentionPushBody,
  dispatchRemoteSessionAttentionSignal,
  isEligibleForRemoteSessionAttention,
} from './remote-session-notifications';

function completedSignal(
  messageExcerpt: string
): Extract<AttentionSignal, { messageExcerpt: string }> {
  return { signalId: 'msg-1', kind: 'completed' as const, messageExcerpt };
}

function needsInputSignal(): Extract<AttentionSignal, { messageExcerpt: string }> {
  return { signalId: 'status:question:123', kind: 'needs_input' as const, messageExcerpt: '' };
}

function agentNotificationSignal(
  message: string
): Extract<AttentionSignal, { kind: 'agent_notification' }> {
  return { kind: 'agent_notification' as const, notificationId: 'n-1', message };
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
  it('sends a push when the remote CLI session is active', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const signal = completedSignal('Done');
    const outcome = await dispatchRemoteSessionAttentionSignal(
      { kiloUserId: 'usr_1', sessionId: 'ses_1', createdOnPlatform: null, signal },
      {
        hasActiveCliSession,
        sendPush,
        sendAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
      }
    );

    expect(outcome).toBe('sent');
    expect(hasActiveCliSession).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledWith({
      userId: 'usr_1',
      cliSessionId: 'ses_1',
      executionId: 'remote:msg-1',
      status: 'completed',
      category: 'status',
      body: 'Done',
      suppressIfViewingSession: true,
    });
  });

  it('tags a needs_input push with category "attention"', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: null,
        signal: needsInputSignal(),
      },
      {
        hasActiveCliSession,
        sendPush,
        sendAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
      }
    );

    expect(outcome).toBe('sent');
    expect(sendPush).toHaveBeenCalledWith({
      userId: 'usr_1',
      cliSessionId: 'ses_1',
      executionId: 'remote:status:question:123',
      status: 'completed',
      category: 'attention',
      body: 'Kilo needs your input.',
      suppressIfViewingSession: true,
    });
  });

  it('suppresses pushes when no remote CLI session is active', async () => {
    const hasActiveCliSession = vi.fn(async () => false);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: null,
        signal: completedSignal('Done'),
      },
      {
        hasActiveCliSession,
        sendPush,
        sendAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
      }
    );

    expect(outcome).toBe('suppressed');
    expect(sendPush).not.toHaveBeenCalled();
  });

  // §4.3: agent_notification signals intentionally bypass the live-CLI gate so a
  // headless `kilo run` that exits immediately after the tool call still delivers the
  // notification the user explicitly asked for.
  it('dispatches an agent_notification signal without checking the live-CLI gate', async () => {
    const hasActiveCliSession = vi.fn(async () => false);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const sendAgentSessionNotification = vi.fn(async () => ({ dispatched: true }));
    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: 'cloud-agent-web',
        signal: agentNotificationSignal('Build done'),
      },
      { hasActiveCliSession, sendPush, sendAgentSessionNotification }
    );

    expect(outcome).toBe('sent');
    expect(hasActiveCliSession).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    expect(sendAgentSessionNotification).toHaveBeenCalledTimes(1);
    expect(sendAgentSessionNotification).toHaveBeenCalledWith({
      userId: 'usr_1',
      cliSessionId: 'ses_1',
      notificationId: 'n-1',
      message: 'Build done',
    });
  });

  it('propagates a thrown agent_notification RPC error (does NOT catch it)', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const sendAgentSessionNotification = vi.fn(async () => {
      throw new Error('transport down');
    });
    await expect(
      dispatchRemoteSessionAttentionSignal(
        {
          kiloUserId: 'usr_1',
          sessionId: 'ses_1',
          createdOnPlatform: 'cloud-agent-web',
          signal: agentNotificationSignal('hi'),
        },
        { hasActiveCliSession, sendPush, sendAgentSessionNotification }
      )
    ).rejects.toThrow('transport down');
  });

  it('returns "suppressed" when the agent_notification RPC returns a non-dispatched reason', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));
    const sendAgentSessionNotification = vi.fn(
      async (): Promise<{ dispatched: false; reason: 'suppressed_presence' }> => ({
        dispatched: false,
        reason: 'suppressed_presence',
      })
    );
    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: 'cloud-agent-web',
        signal: agentNotificationSignal('hi'),
      },
      { hasActiveCliSession, sendPush, sendAgentSessionNotification }
    );

    expect(outcome).toBe('suppressed');
  });

  it('suppresses cloud-agent-web completed signals before checking active CLI state', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));

    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: 'cloud-agent-web',
        signal: completedSignal('Done'),
      },
      {
        hasActiveCliSession,
        sendPush,
        sendAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
      }
    );

    expect(outcome).toBe('suppressed');
    expect(hasActiveCliSession).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('still sends cloud-agent-web needs-input signals when the CLI is active', async () => {
    const hasActiveCliSession = vi.fn(async () => true);
    const sendPush = vi.fn(async () => ({ dispatched: true }));

    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: 'cloud-agent-web',
        signal: needsInputSignal(),
      },
      {
        hasActiveCliSession,
        sendPush,
        sendAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
      }
    );

    expect(outcome).toBe('sent');
    expect(hasActiveCliSession).toHaveBeenCalledOnce();
    expect(sendPush).toHaveBeenCalledOnce();
  });

  it('returns suppressed when the notifications service declines a legacy push', async () => {
    const outcome = await dispatchRemoteSessionAttentionSignal(
      {
        kiloUserId: 'usr_1',
        sessionId: 'ses_1',
        createdOnPlatform: 'unknown',
        signal: completedSignal('Done'),
      },
      {
        hasActiveCliSession: vi.fn(async () => true),
        sendPush: vi.fn(async () => ({ dispatched: false, reason: 'missing_session' }) as const),
        sendAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
      }
    );

    expect(outcome).toBe('suppressed');
  });
});
