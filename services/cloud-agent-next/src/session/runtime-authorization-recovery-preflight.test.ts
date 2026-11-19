import { TRPCError } from '@trpc/server';

import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';
import { RuntimeAuthorizationRevokedError } from '@kilocode/worker-utils/runtime-authorization';

const getRuntimeAuthorizationStatus = vi.fn();
const recoverExpiredRuntimeAuthorization = vi.fn();

const createRuntimeAuthorizationMock = vi.hoisted(() =>
  vi.fn(async () => ({
    authorization: { id: 'authorization-1' },
    token: 'runtime-token',
  }))
);

vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: () => ({
    getRuntimeAuthorizationStatus,
    recoverExpiredRuntimeAuthorization,
  }),
}));

const renewWorkspaceAuthority = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./workspace-authority-renewal.js', () => ({
  renewWorkspaceAuthorityForUserSend: renewWorkspaceAuthority,
}));

vi.mock('./metadata.js', () => ({
  fetchSessionMetadata: vi.fn(async () => ({
    identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
  })),
}));

vi.mock('../auth.js', () => ({ resolveSecret: vi.fn(async () => 'secret') }));

vi.mock('@kilocode/worker-utils/runtime-authorization', async importOriginal => ({
  ...(await importOriginal<typeof RuntimeAuthorizationModule>()),
  createRuntimeAuthorization: createRuntimeAuthorizationMock,
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
const scopedToken = jwt.sign(
  {
    tokenPurpose: 'delegated-workload',
    cloudAgentAuthority: {
      version: 1,
      ownerId: 'usr_1',
      parentSessionId: 'workspace_parent',
      organizationId: null,
      authorizationId: 'authorization-1',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    },
  },
  'test-secret'
);

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

  it('offers the chat workspace for renewal after its own authorization passes', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'active',
      id: 'authorization-1',
      workspaceSessionId: 'workspace_parent',
    });
    await preflightRuntimeAuthorizationRecovery('workspace_a', ctx);
    expect(renewWorkspaceAuthority).toHaveBeenCalledWith({
      env: ctx.env,
      userId: 'usr_1',
      authToken: delegatedToken,
      workspaceSessionId: 'workspace_parent',
    });
  });

  it('does not renew the workspace when the chat itself is revoked', async () => {
    renewWorkspaceAuthority.mockClear();
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'revoked',
      workspaceSessionId: 'workspace_parent',
    });
    await expect(preflightRuntimeAuthorizationRecovery('workspace_a', ctx)).rejects.toThrow();
    expect(renewWorkspaceAuthority).not.toHaveBeenCalled();
  });

  it('does nothing for an active authorization', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({ state: 'active', id: 'authorization-1' });
    await preflightRuntimeAuthorizationRecovery('workspace_a', ctx);
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
  });

  it('does nothing for the legacy credential-compatibility status', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({ state: 'legacy' });
    await preflightRuntimeAuthorizationRecovery('workspace_a', ctx);
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects a revoked authorization with FORBIDDEN', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({ state: 'revoked' });
    await expect(preflightRuntimeAuthorizationRecovery('workspace_a', ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not extend a scoped delegation on expiry recovery', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'expired',
      id: 'authorization-1',
    });
    await expect(
      preflightRuntimeAuthorizationRecovery('workspace_a', { ...ctx, authToken: scopedToken })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
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

  it('maps a refused delegation to a FORBIDDEN authorization denial', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'expired',
      id: 'authorization-1',
    });
    createRuntimeAuthorizationMock.mockRejectedValueOnce(new RuntimeAuthorizationRevokedError());
    const rejection = await preflightRuntimeAuthorizationRecovery('workspace_a', ctx).catch(
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(TRPCError);
    expect(rejection).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Runtime authorization denied',
    });
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected authorization failure unchanged', async () => {
    getRuntimeAuthorizationStatus.mockResolvedValue({
      state: 'expired',
      id: 'authorization-1',
    });
    const failure = new Error('Invalid runtime admission');
    createRuntimeAuthorizationMock.mockRejectedValueOnce(failure);
    await expect(preflightRuntimeAuthorizationRecovery('workspace_a', ctx)).rejects.toBe(failure);
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
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
