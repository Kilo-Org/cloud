import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { TRPCContext } from '../../types.js';

const { queryAccess } = vi.hoisted(() => ({ queryAccess: vi.fn() }));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({})) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: queryAccess,
}));

import { appRouter } from '../../router.js';

const sessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const access: AccessibleCloudAgentSession = {
  kiloSessionId: 'kilo_root',
  organizationId: 'org_current',
};

function setup(userId = 'user_owner') {
  const stub = {
    listPreviewServices: vi.fn().mockResolvedValue({
      services: [{ port: 3001, name: 'Next.js' }],
      status: 'running',
    }),
  };
  const session = { idFromName: vi.fn(name => name), get: vi.fn(() => stub) };
  const context = {
    userId,
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://test' },
      SANDBOX_SESSION: session,
    },
  } as unknown as TRPCContext;
  return { caller: appRouter.createCaller(context), stub, session };
}

describe('listPreviewServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryAccess.mockResolvedValue(access);
  });

  it('authorizes the current session and returns discovered services', async () => {
    const { caller, stub } = setup();

    await expect(caller.listPreviewServices({ cloudAgentSessionId: sessionId })).resolves.toEqual({
      services: [{ port: 3001, name: 'Next.js' }],
      status: 'running',
    });
    expect(queryAccess).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'user_owner',
      cloudAgentSessionId: sessionId,
    });
    expect(stub.listPreviewServices).toHaveBeenCalledTimes(1);
  });

  it('passes a known availability status through without inventing services', async () => {
    const { caller, stub } = setup();
    stub.listPreviewServices.mockResolvedValue({ services: [], status: 'not_running' });

    await expect(caller.listPreviewServices({ cloudAgentSessionId: sessionId })).resolves.toEqual({
      services: [],
      status: 'not_running',
    });
  });

  it('rejects a caller without current session access before touching the sandbox', async () => {
    const { caller, stub } = setup('user_other');
    queryAccess.mockResolvedValue(null);

    await expect(
      caller.listPreviewServices({ cloudAgentSessionId: sessionId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stub.listPreviewServices).not.toHaveBeenCalled();
  });

  it('surfaces a discovery failure instead of returning an empty list', async () => {
    const { caller, stub } = setup();
    stub.listPreviewServices.mockRejectedValue(new Error('scan transport failed'));

    await expect(caller.listPreviewServices({ cloudAgentSessionId: sessionId })).rejects.toThrow(
      'scan transport failed'
    );
  });

  it('rejects non-workspace session ids at the input boundary', async () => {
    const { caller, stub } = setup();

    await expect(
      caller.listPreviewServices({
        cloudAgentSessionId: 'agent_12345678-1234-4234-8234-123456789abc',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stub.listPreviewServices).not.toHaveBeenCalled();
  });
});
