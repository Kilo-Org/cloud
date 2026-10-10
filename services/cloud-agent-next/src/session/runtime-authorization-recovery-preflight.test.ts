import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRuntimeAuthorizationStatus = vi.fn();
const recoverExpiredRuntimeAuthorization = vi.fn();

vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: () => ({
    getRuntimeAuthorizationStatus,
    recoverExpiredRuntimeAuthorization,
  }),
  resolveLegacySessionStub: () => ({
    getRuntimeAuthorizationRecoveryState: getRuntimeAuthorizationStatus,
    recoverExpiredRuntimeAuthorization,
  }),
  resolveSessionStub: () => ({}),
}));

vi.mock('../session-service.js', () => ({
  fetchSessionMetadata: vi.fn(async () => ({
    identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
  })),
}));

vi.mock('../auth.js', () => ({ resolveSecret: vi.fn(async () => 'secret') }));

vi.mock('@kilocode/worker-utils/runtime-authorization', () => ({
  createRuntimeAuthorization: vi.fn(async () => ({
    authorization: { id: 'authorization-1' },
    token: 'runtime-token',
  })),
  sealRuntimeAuthorization: vi.fn(async () => 'runtime-seal'),
}));

vi.mock('../utils/do-retry.js', () => ({
  withDORetry: <TStub, TResult>(
    getStub: () => TStub,
    operation: (stub: TStub) => Promise<TResult>
  ) => operation(getStub()),
}));

import { preflightRuntimeAuthorizationRecovery } from './queue-message.js';

// A decodable token so the preflight treats the request as a delegated grant.
const delegatedToken = jwt.sign({ tokenPurpose: 'cloud-agent' }, 'test-secret');

const ctx = {
  env: { HYPERDRIVE: { connectionString: 'postgres://test' } } as never,
  userId: 'usr_1',
  authToken: delegatedToken,
};

describe('preflightRuntimeAuthorizationRecovery', () => {
  beforeEach(() => {
    getRuntimeAuthorizationStatus.mockReset();
    recoverExpiredRuntimeAuthorization.mockReset();
    recoverExpiredRuntimeAuthorization.mockResolvedValue({ status: 'recovered' });
  });

  it('does nothing for an active authorization', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({ state: 'active', id: 'authorization-1' });
    await preflightRuntimeAuthorizationRecovery('workspace_a', ctx);
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects a revoked authorization with FORBIDDEN', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({ state: 'revoked' });
    await expect(preflightRuntimeAuthorizationRecovery('workspace_a', ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('mints and commits a fresh authorization when the delegation expired', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'expired',
      id: 'authorization-1',
    });
    await preflightRuntimeAuthorizationRecovery('workspace_a', ctx);
    expect(recoverExpiredRuntimeAuthorization).toHaveBeenCalledWith({
      ownerId: 'usr_1',
      expectedOldId: 'authorization-1',
      runtimeAuthorizationSeal: 'runtime-seal',
      runtimeToken: 'runtime-token',
    });
  });

  it('maps a denied recovery to FORBIDDEN', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'expired',
      id: 'authorization-1',
    });
    recoverExpiredRuntimeAuthorization.mockResolvedValue({ status: 'denied' });
    await expect(preflightRuntimeAuthorizationRecovery('workspace_a', ctx)).rejects.toBeInstanceOf(
      TRPCError
    );
  });
});
