import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendCloudAgentSessionNotificationInputSchema,
  sendSessionReadyNotificationInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
} from '@kilocode/notifications';

import {
  dispatchCloudAgentSessionPush,
  dispatchSessionReadyPush,
  type DispatchCloudAgentSessionPushDeps,
} from './cloud-agent-session-push';

type SessionRecord = {
  title: string | null;
  organizationId: string | null;
};

const mockDispatchPush = vi.fn(
  async (_input: DispatchPushInput): Promise<DispatchPushOutcome> => ({
    kind: 'delivered',
    tokenCount: 1,
  })
);

function createDeps(
  options: {
    session?: SessionRecord | null;
    hasOrganizationAccess?: boolean;
  } = {}
): DispatchCloudAgentSessionPushDeps {
  const session =
    options.session === undefined
      ? { title: 'Resolved title', organizationId: null }
      : options.session;

  return {
    getSession: vi.fn(async () => session),
    hasOrganizationAccess: vi.fn(async () => options.hasOrganizationAccess ?? true),
    dispatchPush: mockDispatchPush,
  };
}

describe('dispatchCloudAgentSessionPush', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDispatchPush.mockResolvedValue({ kind: 'delivered', tokenCount: 1 });
  });

  it('dispatches the push through the recipient notification channel', async () => {
    const deps = createDeps();

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_1',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        presenceContext: null,
        idempotencyKey: 'cloud-agent:ses_1:exec_1',
        badge: null,
        push: expect.objectContaining({
          title: 'Resolved title',
          body: 'Finished',
          data: { type: 'cloud_agent_session', cliSessionId: 'ses_1' },
        }),
      })
    );
    expect(deps.hasOrganizationAccess).not.toHaveBeenCalled();
  });

  it('passes the CLI session presence context when requested', async () => {
    const deps = createDeps();

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_1',
        status: 'completed',
        body: 'Finished',
        suppressIfViewingSession: true,
      },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ presenceContext: '/presence/cli-session/ses_1' })
    );
  });

  it('does not pass a presence context when suppression is explicitly disabled', async () => {
    const deps = createDeps();

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_1',
        status: 'completed',
        body: 'Finished',
        suppressIfViewingSession: false,
      },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ presenceContext: null })
    );
  });

  it('keeps follow-up executions in one session idempotent independently', async () => {
    const deps = createDeps();

    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_1',
        status: 'completed',
        body: 'First completion',
      },
      deps
    );
    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_2',
        status: 'completed',
        body: 'Second completion',
      },
      deps
    );

    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:exec_1' })
    );
    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:exec_2' })
    );
  });

  it('reports dispatch failures from the recipient notification channel', async () => {
    const deps = createDeps();
    mockDispatchPush.mockResolvedValue({ kind: 'failed', error: 'Expo unavailable' });

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_failed',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'dispatch_failed' });
  });

  it('returns missing_session without dispatching when the session row is absent', async () => {
    const deps = createDeps({ session: null });

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_missing',
        executionId: 'exec_missing',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'missing_session' });
    expect(mockDispatchPush).not.toHaveBeenCalled();
  });

  it('does not send organization session output after membership is revoked', async () => {
    const deps = createDeps({
      session: { title: 'Private organization session', organizationId: 'org-1' },
      hasOrganizationAccess: false,
    });

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'former-member',
        cliSessionId: 'ses_org',
        executionId: 'exec_org',
        status: 'completed',
        body: 'Private result',
      },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'missing_session' });
    expect(mockDispatchPush).not.toHaveBeenCalled();
    expect(deps.hasOrganizationAccess).toHaveBeenCalledWith('former-member', 'org-1');
  });

  it('sends organization session output while membership is current', async () => {
    const deps = createDeps({
      session: { title: 'Organization session', organizationId: 'org-1' },
      hasOrganizationAccess: true,
    });

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'member',
        cliSessionId: 'ses_org',
        executionId: 'exec_org',
        status: 'completed',
        body: 'Permitted result',
      },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledOnce();
    expect(deps.hasOrganizationAccess).toHaveBeenCalledWith('member', 'org-1');
  });

  it('rejects invalid params before reading session data', async () => {
    const deps = createDeps();

    await expect(
      dispatchCloudAgentSessionPush(
        {
          userId: '',
          cliSessionId: 'ses_1',
          executionId: 'exec_invalid',
          status: 'completed',
          body: 'Finished',
        },
        deps
      )
    ).rejects.toThrow();
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('composes the push title from the session title for an attention dispatch', async () => {
    const deps = createDeps({
      session: { title: 'Refactor auth module', organizationId: null },
    });

    const result = await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'attention:req_1',
        status: 'completed',
        body: 'Kilo needs your input.',
      },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        push: expect.objectContaining({
          title: 'Refactor auth module',
          body: 'Kilo needs your input.',
        }),
      })
    );
  });

  it('falls back to the fixed title when the session title is null', async () => {
    const deps = createDeps({ session: { title: null, organizationId: null } });

    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_null',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ push: expect.objectContaining({ title: 'Agent session' }) })
    );
  });

  it('falls back to the fixed title when the session title is only whitespace', async () => {
    const deps = createDeps({ session: { title: '   \n  \t', organizationId: null } });

    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_ws',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ push: expect.objectContaining({ title: 'Agent session' }) })
    );
  });

  it('truncates a long session title to at most 80 code points ending in ellipsis', async () => {
    // Mix ASCII with a surrogate-pair emoji to exercise the codepoint-safe path.
    const longTitle = 'x'.repeat(70) + ' 🦊 '.repeat(5) + ' tail';
    const deps = createDeps({ session: { title: longTitle, organizationId: null } });

    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_long',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    const calls = mockDispatchPush.mock.calls[0]?.[0] as DispatchPushInput;
    const pushedTitle = calls.push.title;
    expect(pushedTitle.endsWith('...')).toBe(true);
    expect(pushedTitle.includes('\n')).toBe(false);
    expect(Array.from(pushedTitle).length).toBeLessThanOrEqual(80);
    // No lone surrogate: if the truncation keeps the emoji, it must remain intact;
    // otherwise the truncation point must be on an ASCII/space boundary.
    if (pushedTitle.includes('🦊')) {
      // Surviving emoji must be the full code point sequence, not a lone surrogate.
      expect(pushedTitle.includes('\uD83E')).toBe(true);
    }
  });

  it('truncates surrogate-pair emoji by code points, not UTF-16 code units', async () => {
    const emojiTitle = '🦊'.repeat(85);
    const expected = '🦊'.repeat(77) + '...';
    const deps = createDeps({ session: { title: emojiTitle, organizationId: null } });

    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_emoji_surrogate',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    const calls = mockDispatchPush.mock.calls[0]?.[0] as DispatchPushInput;
    const pushedTitle = calls.push.title;
    expect(pushedTitle).toBe(expected);
    expect(Array.from(pushedTitle).length).toBe(80);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(pushedTitle)
    ).toBe(false);
  });

  it('collapses whitespace runs (including newlines/tabs) into single spaces', async () => {
    const deps = createDeps({
      session: { title: 'Refactor\n\nthe\t auth  module', organizationId: null },
    });

    await dispatchCloudAgentSessionPush(
      {
        userId: 'user-1',
        cliSessionId: 'ses_1',
        executionId: 'exec_ws',
        status: 'completed',
        body: 'Finished',
      },
      deps
    );

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        push: expect.objectContaining({ title: 'Refactor the auth module' }),
      })
    );
  });
});

describe('dispatchSessionReadyPush', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDispatchPush.mockResolvedValue({ kind: 'delivered', tokenCount: 1 });
  });

  it('dispatches fixed copy with app presence suppression and per-session idempotency', async () => {
    const deps = createDeps({ session: { title: null, organizationId: null } });

    const result = await dispatchSessionReadyPush(
      { userId: 'user-1', cliSessionId: 'ses_1' },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        presenceContext: '/presence/app',
        idempotencyKey: 'cloud-agent:ses_1:session-ready',
        badge: null,
        push: expect.objectContaining({
          title: 'Kilo session ready',
          body: 'Your Kilo session is ready to control from your phone',
          data: { type: 'cloud_agent_session', cliSessionId: 'ses_1' },
        }),
      })
    );
  });

  it('returns missing_session without dispatching when the session row is absent', async () => {
    const deps = createDeps({ session: null });

    const result = await dispatchSessionReadyPush(
      { userId: 'user-1', cliSessionId: 'ses_missing' },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'missing_session' });
    expect(mockDispatchPush).not.toHaveBeenCalled();
  });

  it('does not send for organization sessions the user cannot access', async () => {
    const deps = createDeps({
      session: { title: null, organizationId: 'org-1' },
      hasOrganizationAccess: false,
    });

    const result = await dispatchSessionReadyPush(
      { userId: 'former-member', cliSessionId: 'ses_org' },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'missing_session' });
    expect(mockDispatchPush).not.toHaveBeenCalled();
  });

  it('reports dispatch failures from the recipient notification channel', async () => {
    const deps = createDeps();
    mockDispatchPush.mockResolvedValue({ kind: 'failed', error: 'Expo unavailable' });

    const result = await dispatchSessionReadyPush(
      { userId: 'user-1', cliSessionId: 'ses_1' },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'dispatch_failed' });
  });

  it('prefers the heartbeat hint title over the DB title when both are present', async () => {
    const deps = createDeps({
      session: { title: 'DB title', organizationId: null },
    });

    const result = await dispatchSessionReadyPush(
      { userId: 'user-1', cliSessionId: 'ses_1', title: 'Heartbeat title' },
      deps
    );

    expect(result).toEqual({ dispatched: true });
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        push: expect.objectContaining({
          title: 'Heartbeat title',
          body: 'Your Kilo session is ready to control from your phone',
        }),
      })
    );
  });

  it('uses the DB title when no heartbeat hint is provided', async () => {
    const deps = createDeps({
      session: { title: 'DB title', organizationId: null },
    });

    await dispatchSessionReadyPush({ userId: 'user-1', cliSessionId: 'ses_1' }, deps);

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        push: expect.objectContaining({
          title: 'DB title',
          body: 'Your Kilo session is ready to control from your phone',
        }),
      })
    );
  });

  it('falls back to the fixed copy when no hint and no DB title are present', async () => {
    const deps = createDeps({ session: { title: null, organizationId: null } });

    await dispatchSessionReadyPush({ userId: 'user-1', cliSessionId: 'ses_1' }, deps);

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        push: expect.objectContaining({
          title: 'Kilo session ready',
          body: 'Your Kilo session is ready to control from your phone',
        }),
      })
    );
  });
});

describe('sendCloudAgentSessionNotificationInputSchema', () => {
  it('accepts suppressIfViewingSession and strips unrelated fields', () => {
    const parsed = sendCloudAgentSessionNotificationInputSchema.parse({
      userId: 'user-1',
      cliSessionId: 'ses_1',
      executionId: 'exec_1',
      status: 'completed',
      body: 'Finished',
      suppressIfViewingSession: true,
      extra: 'stripped',
    });

    expect(parsed).toEqual({
      userId: 'user-1',
      cliSessionId: 'ses_1',
      executionId: 'exec_1',
      status: 'completed',
      body: 'Finished',
      suppressIfViewingSession: true,
    });
  });
});

describe('sendSessionReadyNotificationInputSchema', () => {
  it('accepts input without title and strips unknown keys', () => {
    const parsed = sendSessionReadyNotificationInputSchema.parse({
      userId: 'user-1',
      cliSessionId: 'ses_1',
      extra: 'stripped',
    });

    expect(parsed).toEqual({
      userId: 'user-1',
      cliSessionId: 'ses_1',
    });
  });

  it('accepts input with a title', () => {
    const parsed = sendSessionReadyNotificationInputSchema.parse({
      userId: 'user-1',
      cliSessionId: 'ses_1',
      title: 'Heartbeat title',
      extra: 'stripped',
    });

    expect(parsed).toEqual({
      userId: 'user-1',
      cliSessionId: 'ses_1',
      title: 'Heartbeat title',
    });
  });
});
