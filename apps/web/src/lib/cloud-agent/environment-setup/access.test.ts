import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { TRPCError } from '@trpc/server';
import { ENVIRONMENT_SETUP_TOGGLE, requireAgentScope } from './access';

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(),
}));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  getOrganizationById: jest.fn(),
}));

const runId = '11111111-1111-4111-8111-111111111111';
const otherRunId = '22222222-2222-4222-8222-222222222222';
const environmentId = '33333333-3333-4333-8333-333333333333';
const organizationId = '44444444-4444-4444-8444-444444444444';
const userId = 'user_environment_setup';

function authority(
  environmentSetup: CloudAgentAuthority['environmentSetup'],
  organization: string | null = null
): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: userId,
    parentSessionId: 'workspace_parent',
    organizationId: organization,
    authorizationId: '55555555-5555-4555-8555-555555555555',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...(environmentSetup ? { environmentSetup } : {}),
  };
}

function context(cloudAgentAuthority?: CloudAgentAuthority): TRPCContext {
  return { user: { id: userId }, cloudAgentAuthority } as unknown as TRPCContext;
}

describe('requireAgentScope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ensureOrganizationAccess).mockResolvedValue('member');
    jest.mocked(getOrganizationById).mockResolvedValue({ id: organizationId } as never);
    jest.mocked(isReleaseToggleEnabled).mockResolvedValue(true);
  });

  it('rejects a missing claim before checking roles or the toggle', async () => {
    await expect(requireAgentScope(context(), runId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Environment setup authority required',
    });

    expect(ensureOrganizationAccess).not.toHaveBeenCalled();
    expect(isReleaseToggleEnabled).not.toHaveBeenCalled();
  });

  it('rejects a claim for another run', async () => {
    const ctx = context(authority({ runId: otherRunId, environmentId }));

    await expect(requireAgentScope(ctx, runId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Environment setup authority required',
    });

    expect(ensureOrganizationAccess).not.toHaveBeenCalled();
    expect(isReleaseToggleEnabled).not.toHaveBeenCalled();
  });

  it('rejects a member of the organization', async () => {
    jest
      .mocked(ensureOrganizationAccess)
      .mockRejectedValue(
        new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization access required' })
      );
    const ctx = context(authority({ runId, environmentId }, organizationId));

    await expect(requireAgentScope(ctx, runId)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    expect(ensureOrganizationAccess).toHaveBeenCalledWith(
      ctx,
      organizationId,
      ORGANIZATION_MANAGE_ROLES
    );
    expect(isReleaseToggleEnabled).not.toHaveBeenCalled();
  });

  it('accepts an admin with a matching claim', async () => {
    jest.mocked(ensureOrganizationAccess).mockResolvedValue('owner');
    const ctx = context(authority({ runId, environmentId }, organizationId));

    await expect(requireAgentScope(ctx, runId)).resolves.toEqual({
      owner: { type: 'organization', id: organizationId },
      organizationId,
      claim: { runId, environmentId },
    });

    expect(ensureOrganizationAccess).toHaveBeenCalledWith(
      ctx,
      organizationId,
      ORGANIZATION_MANAGE_ROLES
    );
    expect(getOrganizationById).toHaveBeenCalledWith(organizationId);
    expect(isReleaseToggleEnabled).toHaveBeenCalledWith(ENVIRONMENT_SETUP_TOGGLE, userId);
  });

  it('accepts a personal authority without an organization check', async () => {
    const ctx = context(authority({ runId, environmentId }));

    await expect(requireAgentScope(ctx, runId)).resolves.toEqual({
      owner: { type: 'user', id: userId },
      organizationId: undefined,
      claim: { runId, environmentId },
    });

    expect(ensureOrganizationAccess).not.toHaveBeenCalled();
    expect(isReleaseToggleEnabled).toHaveBeenCalledWith(ENVIRONMENT_SETUP_TOGGLE, userId);
  });

  it('rejects when the toggle is disabled', async () => {
    jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
    const ctx = context(authority({ runId, environmentId }));

    await expect(requireAgentScope(ctx, runId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Environment setup agent is not available',
    });
  });
});
