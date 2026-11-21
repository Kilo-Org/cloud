import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type * as RuntimeAuthorizationModule from '@kilocode/worker-utils/runtime-authorization';
import type { Env } from '../types.js';

const { describeWorkspace, reauthorize, createAuthorization } = vi.hoisted(() => ({
  describeWorkspace: vi.fn(),
  reauthorize: vi.fn(),
  createAuthorization: vi.fn(),
}));
vi.mock('../control-plane/workspace/workspace-stub.js', () => ({
  getWorkspaceStub: () => ({ describe: describeWorkspace, reauthorize }),
}));
vi.mock('../utils/do-retry.js', () => ({
  withDORetry: async (getStub: () => unknown, operation: (stub: unknown) => unknown) =>
    operation(getStub()),
}));
vi.mock('@kilocode/worker-utils/runtime-authorization', async importActual => ({
  ...(await importActual<typeof RuntimeAuthorizationModule>()),
  createRuntimeAuthorization: createAuthorization,
  sealRuntimeAuthorization: async () => 'fresh-workspace-seal',
}));

const { renewWorkspaceAuthorityForUserSend } = await import('./workspace-authority-renewal.js');

const userId = 'oauth/owner';
const workspaceSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const env = {
  NEXTAUTH_SECRET: 'fixture-secret',
  HYPERDRIVE: { connectionString: 'postgres://fixture' },
  ENVIRONMENT: 'production',
} as unknown as Env;

function token(claims: Record<string, unknown>): string {
  return jwt.sign(claims, 'fixture');
}

const userAdmission = token({
  aud: 'cloud-agent-next',
  tokenPurpose: 'human-api',
  runtimeAdmission: { source: 'user', authorizationUserId: userId, authorizationPepper: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  describeWorkspace.mockResolvedValue({
    state: 'expired',
    authorizationId: '12345678-1234-4234-8234-123456789abc',
    worktreeId: 'worktree_12345678-1234-4234-8234-123456789abc',
    organizationId: null,
  });
  createAuthorization.mockResolvedValue({ authorization: { id: 'fresh' }, token: 'runtime' });
  reauthorize.mockResolvedValue({ status: 'renewed' });
});

describe('workspace authority renewal on a user send', () => {
  it('renews an expired workspace from the owner credential, bound to the workspace', async () => {
    await renewWorkspaceAuthorityForUserSend({
      env,
      userId,
      authToken: userAdmission,
      workspaceSessionId,
    });
    expect(createAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        token: userAdmission,
        resourceKind: 'cloud-agent-next',
        resourceId: workspaceSessionId,
      })
    );
    expect(createAuthorization.mock.calls[0][0]).not.toHaveProperty('organizationId');
    expect(reauthorize).toHaveBeenCalledWith({
      expectedAuthorizationId: '12345678-1234-4234-8234-123456789abc',
      runtimeAuthorizationSeal: 'fresh-workspace-seal',
    });
  });

  it('binds an organization workspace renewal to that organization', async () => {
    describeWorkspace.mockResolvedValue({
      state: 'expired',
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      worktreeId: null,
      organizationId: 'org-1',
    });
    await renewWorkspaceAuthorityForUserSend({
      env,
      userId,
      authToken: userAdmission,
      workspaceSessionId,
    });
    expect(createAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' })
    );
  });

  it.each(['active', 'revoked', 'deleted', 'unestablished'] as const)(
    'leaves a %s workspace unchanged',
    async state => {
      describeWorkspace.mockResolvedValue({
        state,
        authorizationId: state === 'active' || state === 'revoked' ? 'id' : null,
        worktreeId: null,
        organizationId: null,
      });
      await renewWorkspaceAuthorityForUserSend({
        env,
        userId,
        authToken: userAdmission,
        workspaceSessionId,
      });
      expect(createAuthorization).not.toHaveBeenCalled();
      expect(reauthorize).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a Cloud Agent authority', { aud: 'cloud-agent-next', cloudAgentAuthority: {} }],
    ['a delegated runtime token', { aud: 'kilo-api', runtimeAuthorization: { id: 'x' } }],
    [
      'an automation admission',
      { aud: 'cloud-agent-next', runtimeAdmission: { source: 'automation' } },
    ],
    ['a legacy token', { kiloUserId: userId }],
  ])('never renews from %s', async (_name, claims) => {
    await renewWorkspaceAuthorityForUserSend({
      env,
      userId,
      authToken: token(claims),
      workspaceSessionId,
    });
    expect(describeWorkspace).not.toHaveBeenCalled();
  });

  it('does not fail the send when renewal is unavailable', async () => {
    createAuthorization.mockRejectedValue(new Error('membership unavailable'));
    await expect(
      renewWorkspaceAuthorityForUserSend({
        env,
        userId,
        authToken: userAdmission,
        workspaceSessionId,
      })
    ).resolves.toBeUndefined();
    expect(reauthorize).not.toHaveBeenCalled();
  });

  it('does nothing for a chat that cannot launch children', async () => {
    await renewWorkspaceAuthorityForUserSend({
      env,
      userId,
      authToken: userAdmission,
      workspaceSessionId: undefined,
    });
    expect(describeWorkspace).not.toHaveBeenCalled();
  });
});
