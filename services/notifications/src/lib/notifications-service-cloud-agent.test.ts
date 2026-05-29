import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DispatchPushInput, type DispatchPushOutcome } from '@kilocode/notifications';

import {
  dispatchCloudAgentSessionPush,
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
