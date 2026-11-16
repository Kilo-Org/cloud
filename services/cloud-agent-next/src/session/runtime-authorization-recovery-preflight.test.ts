import { TRPCError } from '@trpc/server';

import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';
import { RuntimeAuthorizationRevokedError } from '@kilocode/worker-utils/runtime-authorization';

const getRuntimeAuthorizationStatus = vi.fn();
const recoverExpiredRuntimeAuthorization = vi.fn();

const { createRuntimeAuthorizationMock, logRuntimeAuthorizationDiagnosticMock } = vi.hoisted(
  () => ({
    createRuntimeAuthorizationMock: vi.fn(
      async (
        _input: Parameters<typeof RuntimeAuthorizationModule.createRuntimeAuthorization>[0]
      ) => ({
        authorization: { id: 'authorization-1' },
        token: 'runtime-token',
      })
    ),
    logRuntimeAuthorizationDiagnosticMock: vi.fn(),
  })
);

vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: () => ({
    getRuntimeAuthorizationStatus,
    recoverExpiredRuntimeAuthorization,
  }),
}));

vi.mock('./metadata.js', () => ({
  fetchSessionMetadata: vi.fn(async () => ({
    identity: { sessionId: 'workspace_12345678-1234-1234-1234-123456789abc', userId: 'usr_1' },
  })),
}));

vi.mock('../auth.js', () => ({ resolveSecret: vi.fn(async () => 'secret') }));

vi.mock('./runtime-authorization-diagnostics.js', () => ({
  logRuntimeAuthorizationDiagnostic: logRuntimeAuthorizationDiagnosticMock,
}));

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
    createRuntimeAuthorizationMock.mockClear();
    logRuntimeAuthorizationDiagnosticMock.mockClear();
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
    await expect(preflightRuntimeAuthorizationRecovery('workspace_a', ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Runtime authorization denied',
    });
    expect(recoverExpiredRuntimeAuthorization).not.toHaveBeenCalled();
    const [input] = createRuntimeAuthorizationMock.mock.calls.at(-1) ?? [];
    input?.onBindingRejected?.('device_session_inactive');
    expect(logRuntimeAuthorizationDiagnosticMock).toHaveBeenCalledWith(
      'workspace_a',
      'preflight',
      'device_session_inactive'
    );
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
