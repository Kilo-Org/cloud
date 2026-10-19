import { describe, expect, it, vi } from 'vitest';
import type { Env, TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { hostedSessionLifecycleRouter } from './hosted-session-lifecycle.js';

const userId = 'oauth/google:hosted-owner';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111' as const;
const kiloSessionId = 'ses_12345678901234567890123456';

function fixture() {
  const getHostedLifecycle = vi.fn(async () => ({
    type: 'found' as const,
    lifecycle: { state: 'active' as const, generation: 2 },
  }));
  const stopHostedSession = vi.fn(async () => ({
    type: 'found' as const,
    lifecycle: {
      state: 'stopped' as const,
      generation: 3,
      stoppedAt: 10,
      latestEventId: 7,
    },
  }));
  const resumeHostedSession = vi.fn(async () => ({
    type: 'found' as const,
    lifecycle: { state: 'active' as const, generation: 4 },
  }));
  const stub = { getHostedLifecycle, stopHostedSession, resumeHostedSession };
  const ctx = {
    env: {
      HYPERDRIVE: { connectionString: 'postgres://test' },
      SANDBOX_SESSION: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => stub,
      },
    } as unknown as Env,
    userId,
    authToken: 'token',
    request: new Request('https://worker.test/trpc/getHostedSessionLifecycle'),
  } satisfies TRPCContext;
  return { caller: router(hostedSessionLifecycleRouter).createCaller(ctx), stub };
}

vi.mock('../../db/pg.js', () => ({ getPgDb: vi.fn() }));
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => [{ kiloSessionId, organizationId: null }],
            }),
          }),
        }),
      }),
    }),
  }),
}));

describe('hosted session lifecycle handlers', () => {
  it('returns stable identities and delegates logical lifecycle operations', async () => {
    const { caller, stub } = fixture();
    await expect(caller.getHostedSessionLifecycle({ cloudAgentSessionId })).resolves.toMatchObject({
      cloudAgentSessionId,
      kiloSessionId,
      lifecycle: { state: 'active', generation: 2 },
    });
    await expect(caller.stopHostedSession({ cloudAgentSessionId })).resolves.toMatchObject({
      lifecycle: { state: 'stopped', latestEventId: 7 },
    });
    await expect(caller.resumeHostedSession({ cloudAgentSessionId })).resolves.toMatchObject({
      lifecycle: { state: 'active', generation: 4 },
    });
    expect(stub.getHostedLifecycle).toHaveBeenCalledOnce();
    expect(stub.stopHostedSession).toHaveBeenCalledOnce();
    expect(stub.resumeHostedSession).toHaveBeenCalledOnce();
  });

  it('rejects legacy or malformed session identities before access checks', async () => {
    const { caller, stub } = fixture();
    await expect(
      caller.stopHostedSession({
        cloudAgentSessionId: 'agent_11111111-1111-4111-8111-111111111111',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stub.stopHostedSession).not.toHaveBeenCalled();
  });
});
