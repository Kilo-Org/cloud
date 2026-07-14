import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DispatchPushInput, type DispatchPushOutcome } from '@kilocode/notifications';

import {
  dispatchCloudAgentSessionPush,
  dispatchSessionAttentionPush,
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
});

describe('dispatchSessionAttentionPush', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDispatchPush.mockResolvedValue({ kind: 'delivered', tokenCount: 1 });
  });

  it.each([
    ['question', 'Kilo session needs your input', 'Your Kilo session is asking a question'],
    [
      'permission',
      'Kilo session needs permission',
      'Your Kilo session is waiting for permission to continue',
    ],
    [
      'blocking_suggestion',
      'Kilo session needs a decision',
      'Your Kilo session has a suggestion that needs your review',
    ],
    [
      'action_required',
      'Kilo session needs you',
      'Your Kilo session is waiting for you to take action',
    ],
  ] as const)(
    'dispatches fixed safe copy for reason=%s with exact-session presence',
    async (reason, title, body) => {
      const deps = createDeps({ session: { title: 'Title', organizationId: null } });

      const result = await dispatchSessionAttentionPush(
        { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_1', reason },
        deps
      );

      expect(result).toEqual({ dispatched: true });
      expect(mockDispatchPush).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          presenceContext: '/presence/agent-session/ses_1',
          idempotencyKey: `cloud-agent:ses_1:attention:${reason}:req_1`,
          badge: null,
          push: {
            title,
            body,
            data: { type: 'cloud_agent_session', cliSessionId: 'ses_1' },
            sound: 'default',
            priority: 'high',
          },
        })
      );
    }
  );

  it('ignores any caller-provided body and only uses fixed copy', async () => {
    const deps = createDeps({ session: { title: 'Title', organizationId: null } });

    // The schema has no text/body field and strips unknown keys, so any
    // caller-provided text is silently dropped and the fixed copy is used.
    await expect(
      dispatchSessionAttentionPush(
        {
          userId: 'user-1',
          cliSessionId: 'ses_1',
          requestId: 'req_1',
          reason: 'question',
          // @ts-expect-error -- callers must not be able to inject free-form copy
          body: 'leak this',
        },
        deps
      )
    ).resolves.toEqual({ dispatched: true });

    const call = mockDispatchPush.mock.calls[0]?.[0];
    expect(call?.push.body).toBe('Your Kilo session is asking a question');
    expect(call?.push.body).not.toContain('leak this');
  });

  it('uses distinct idempotency keys for distinct requests and reasons', async () => {
    const deps = createDeps();

    await dispatchSessionAttentionPush(
      { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_1', reason: 'question' },
      deps
    );
    await dispatchSessionAttentionPush(
      { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_2', reason: 'question' },
      deps
    );
    await dispatchSessionAttentionPush(
      { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_1', reason: 'permission' },
      deps
    );

    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:attention:question:req_1' })
    );
    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:attention:question:req_2' })
    );
    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:attention:permission:req_1' })
    );
  });

  it('reuses the same idempotency key when the same request is retried', async () => {
    const deps = createDeps();

    const params = {
      userId: 'user-1',
      cliSessionId: 'ses_1',
      requestId: 'req_dup',
      reason: 'question',
    } as const;
    await dispatchSessionAttentionPush(params, deps);
    await dispatchSessionAttentionPush(params, deps);

    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:attention:question:req_dup' })
    );
    expect(mockDispatchPush).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'cloud-agent:ses_1:attention:question:req_dup' })
    );
  });

  it('returns missing_session without dispatching when the session row is absent', async () => {
    const deps = createDeps({ session: null });

    const result = await dispatchSessionAttentionPush(
      { userId: 'user-1', cliSessionId: 'ses_missing', requestId: 'req_1', reason: 'question' },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'missing_session' });
    expect(mockDispatchPush).not.toHaveBeenCalled();
  });

  it('returns missing_session when org membership has been revoked', async () => {
    const deps = createDeps({
      session: { title: 'Org session', organizationId: 'org-1' },
      hasOrganizationAccess: false,
    });

    const result = await dispatchSessionAttentionPush(
      {
        userId: 'former-member',
        cliSessionId: 'ses_org',
        requestId: 'req_1',
        reason: 'permission',
      },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'missing_session' });
    expect(mockDispatchPush).not.toHaveBeenCalled();
    expect(deps.hasOrganizationAccess).toHaveBeenCalledWith('former-member', 'org-1');
  });

  it('propagates presence-suppressed outcome from the recipient DO', async () => {
    const deps = createDeps();
    mockDispatchPush.mockResolvedValue({ kind: 'suppressed_presence' });

    const result = await dispatchSessionAttentionPush(
      { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_1', reason: 'question' },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'suppressed_presence' });
  });

  it('propagates dispatch failures from the recipient notification channel', async () => {
    const deps = createDeps();
    mockDispatchPush.mockResolvedValue({ kind: 'failed', error: 'Expo unavailable' });

    const result = await dispatchSessionAttentionPush(
      { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_1', reason: 'question' },
      deps
    );

    expect(result).toEqual({ dispatched: false, reason: 'dispatch_failed' });
  });

  it('treats delivered, duplicate, and no_tokens as dispatched', async () => {
    const outcomes: DispatchPushOutcome[] = [
      { kind: 'delivered', tokenCount: 2 },
      { kind: 'duplicate' },
      { kind: 'no_tokens' },
    ];
    for (const outcome of outcomes) {
      const deps = createDeps();
      mockDispatchPush.mockResolvedValueOnce(outcome);
      const result = await dispatchSessionAttentionPush(
        { userId: 'user-1', cliSessionId: 'ses_1', requestId: 'req_1', reason: 'question' },
        deps
      );
      expect(result).toEqual({ dispatched: true });
    }
  });

  it('rejects invalid params (empty IDs, unknown reason) before reading session data', async () => {
    const deps = createDeps();

    await expect(
      dispatchSessionAttentionPush(
        { userId: '', cliSessionId: 'ses_1', requestId: 'req_1', reason: 'question' },
        deps
      )
    ).rejects.toThrow();
    await expect(
      dispatchSessionAttentionPush(
        { userId: 'user-1', cliSessionId: '', requestId: 'req_1', reason: 'question' },
        deps
      )
    ).rejects.toThrow();
    await expect(
      dispatchSessionAttentionPush(
        { userId: 'user-1', cliSessionId: 'ses_1', requestId: '', reason: 'question' },
        deps
      )
    ).rejects.toThrow();
    await expect(
      dispatchSessionAttentionPush(
        {
          userId: 'user-1',
          cliSessionId: 'ses_1',
          requestId: 'req_1',
          // @ts-expect-error -- unknown reason must be rejected
          reason: 'unknown',
        },
        deps
      )
    ).rejects.toThrow();
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});
