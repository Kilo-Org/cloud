import { describe, expect, it, vi } from 'vitest';
import { BitbucketApiError, type BitbucketRepository } from './bitbucket-api.js';
import {
  listBitbucketRepositories,
  resolveBitbucketToken,
} from './bitbucket-runtime-token-resolver.js';
import {
  BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS,
  type BitbucketAuthorizationResult,
} from './bitbucket-authorization-service.js';
import type { BitbucketWorkspaceAccessTokenAuthorization } from './bitbucket-workspace-access-token-authorization-service.js';

const organizationId = '123e4567-e89b-12d3-a456-426614174030';
const workspaceUuid = '123e4567-e89b-12d3-a456-426614174031';
const repositoryUuid = '123e4567-e89b-12d3-a456-426614174032';
const authorization: BitbucketWorkspaceAccessTokenAuthorization = {
  status: 'available',
  token: 'ATCT-runtime-token',
  organizationId,
  integrationId: '123e4567-e89b-12d3-a456-426614174033',
  credentialId: '123e4567-e89b-12d3-a456-426614174034',
  credentialVersion: 7,
  workspace: { uuid: workspaceUuid, slug: 'acme' },
};
const repository: BitbucketRepository = {
  id: repositoryUuid,
  workspaceUuid,
  name: 'Widgets',
  fullName: 'acme/widgets',
  private: true,
  defaultBranch: 'main',
};
const oauthAuthorization: Extract<BitbucketAuthorizationResult, { status: 'available' }> = {
  status: 'available',
  token: 'oauth-runtime-token',
  integrationId: '123e4567-e89b-12d3-a456-426614174044',
  workspace: { uuid: workspaceUuid, slug: 'acme', name: 'Acme' },
};

function dependencies() {
  return {
    authorizationService: {
      getAuthorization: vi.fn().mockResolvedValue(authorization),
      invalidateAuthorization: vi.fn().mockResolvedValue(undefined),
    },
    oauthAuthorizationService: {
      getAuthorization: vi.fn().mockResolvedValue({ status: 'not_connected' }),
    },
    listRepositories: vi.fn().mockResolvedValue([repository]),
    findCachedRepository: vi.fn().mockResolvedValue({ status: 'available', repository }),
  };
}

function tokenParams(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'member-1',
    orgId: organizationId,
    workspaceUuid,
    repositoryUuid,
    repositoryUrl: 'https://bitbucket.org/acme/widgets.git',
    ...overrides,
  };
}

describe('Bitbucket runtime token resolver', () => {
  it('requires an organization before static credential lookup', async () => {
    const deps = dependencies();

    await expect(
      resolveBitbucketToken({} as CloudflareEnv, tokenParams({ orgId: undefined }), deps)
    ).resolves.toEqual({ success: false, reason: 'invalid_request' });
    await expect(
      listBitbucketRepositories({} as CloudflareEnv, { userId: 'member-1' }, deps)
    ).resolves.toEqual({ status: 'invalid_request' });
    expect(deps.authorizationService.getAuthorization).not.toHaveBeenCalled();
    expect(deps.oauthAuthorizationService.getAuthorization).not.toHaveBeenCalled();
  });

  it('releases only the opaque token after exact cached repository validation', async () => {
    const deps = dependencies();

    await expect(resolveBitbucketToken({} as CloudflareEnv, tokenParams(), deps)).resolves.toEqual({
      success: true,
      token: 'ATCT-runtime-token',
    });
    expect(deps.authorizationService.getAuthorization).toHaveBeenCalledWith({
      userId: 'member-1',
      orgId: organizationId,
    });
    expect(deps.findCachedRepository).toHaveBeenCalledWith({
      integrationId: authorization.integrationId,
      organizationId,
      workspace: authorization.workspace,
      repositoryUuid,
    });
    expect(deps.listRepositories).not.toHaveBeenCalled();
    expect(deps.oauthAuthorizationService.getAuthorization).not.toHaveBeenCalled();
  });

  it('lists repositories through the same organization-only static authorization', async () => {
    const deps = dependencies();

    await expect(
      listBitbucketRepositories(
        {} as CloudflareEnv,
        { userId: 'member-1', orgId: organizationId },
        deps
      )
    ).resolves.toEqual({ status: 'available', repositories: [repository] });
    expect(deps.listRepositories).toHaveBeenCalledWith({
      accessToken: 'ATCT-runtime-token',
      workspace: authorization.workspace,
    });
    expect(deps.oauthAuthorizationService.getAuthorization).not.toHaveBeenCalled();
  });

  it('falls back to OAuth authorization when no Workspace Access Token is connected', async () => {
    const deps = dependencies();
    deps.authorizationService.getAuthorization.mockResolvedValue({ status: 'not_connected' });
    deps.oauthAuthorizationService.getAuthorization.mockResolvedValue(oauthAuthorization);

    await expect(
      listBitbucketRepositories(
        {} as CloudflareEnv,
        { userId: 'member-1', orgId: organizationId },
        deps
      )
    ).resolves.toEqual({ status: 'available', repositories: [repository] });
    expect(deps.oauthAuthorizationService.getAuthorization).toHaveBeenCalledWith({
      userId: 'member-1',
      orgId: organizationId,
    });
    expect(deps.listRepositories).toHaveBeenCalledWith({
      accessToken: 'oauth-runtime-token',
      workspace: oauthAuthorization.workspace,
    });
  });

  it('uses the cached repository and Cloud Agent validity threshold for OAuth tokens', async () => {
    const deps = dependencies();
    deps.authorizationService.getAuthorization.mockResolvedValue({ status: 'not_connected' });
    deps.oauthAuthorizationService.getAuthorization.mockResolvedValue(oauthAuthorization);

    await expect(resolveBitbucketToken({} as CloudflareEnv, tokenParams(), deps)).resolves.toEqual({
      success: true,
      token: 'oauth-runtime-token',
    });
    expect(deps.oauthAuthorizationService.getAuthorization).toHaveBeenCalledWith(
      { userId: 'member-1', orgId: organizationId },
      BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS
    );
    expect(deps.findCachedRepository).toHaveBeenCalledWith({
      integrationId: oauthAuthorization.integrationId,
      organizationId,
      workspace: oauthAuthorization.workspace,
      repositoryUuid,
    });
  });

  it('does not fall back to OAuth while a Workspace Access Token needs attention', async () => {
    const deps = dependencies();
    deps.authorizationService.getAuthorization.mockResolvedValue({ status: 'reconnect_required' });
    deps.oauthAuthorizationService.getAuthorization.mockResolvedValue(oauthAuthorization);

    await expect(
      listBitbucketRepositories(
        {} as CloudflareEnv,
        { userId: 'member-1', orgId: organizationId },
        deps
      )
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(deps.oauthAuthorizationService.getAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication_rejected', 'reconnect_required', 'provider_rejected'],
    ['insufficient_permissions', 'insufficient_permissions', null],
    ['workspace_mismatch', 'reconnect_required', 'workspace_mismatch'],
    ['rate_limited', 'temporarily_unavailable', null],
  ] as const)(
    'maps repository-list provider failure %s to %s',
    async (code, status, invalidationReason) => {
      const deps = dependencies();
      deps.listRepositories.mockRejectedValue(new BitbucketApiError(code));

      await expect(
        listBitbucketRepositories(
          {} as CloudflareEnv,
          { userId: 'member-1', orgId: organizationId },
          deps
        )
      ).resolves.toEqual({ status });
      if (invalidationReason) {
        expect(deps.authorizationService.invalidateAuthorization).toHaveBeenCalledTimes(1);
        expect(deps.authorizationService.invalidateAuthorization).toHaveBeenCalledWith(
          authorization,
          invalidationReason
        );
      } else {
        expect(deps.authorizationService.invalidateAuthorization).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['not_connected', 'not_connected'],
    ['repository_not_found', 'repository_not_found'],
    ['temporarily_unavailable', 'temporarily_unavailable'],
  ] as const)(
    'maps cached repository status %s without provider access',
    async (status, reason) => {
      const deps = dependencies();
      deps.findCachedRepository.mockResolvedValue({ status });

      await expect(
        resolveBitbucketToken({} as CloudflareEnv, tokenParams(), deps)
      ).resolves.toEqual({
        success: false,
        reason,
      });
      expect(deps.listRepositories).not.toHaveBeenCalled();
      expect(deps.authorizationService.invalidateAuthorization).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ workspaceUuid: '123e4567-e89b-12d3-a456-426614174099' }, 'workspace_mismatch'],
    [{ repositoryUrl: 'https://bitbucket.org/other/widgets.git' }, 'workspace_mismatch'],
    [{ repositoryUrl: 'https://user@bitbucket.org/acme/widgets.git' }, 'invalid_request'],
    [{ integrationId: '123e4567-e89b-12d3-a456-426614174099' }, 'not_connected'],
  ] as const)(
    'fails before provider access when request identity drifts %#',
    async (overrides, reason) => {
      const deps = dependencies();

      await expect(
        resolveBitbucketToken({} as CloudflareEnv, tokenParams(overrides), deps)
      ).resolves.toEqual({ success: false, reason });
      expect(deps.findCachedRepository).not.toHaveBeenCalled();
      expect(deps.authorizationService.invalidateAuthorization).not.toHaveBeenCalled();
    }
  );

  it.each([
    { ...repository, id: '123e4567-e89b-12d3-a456-426614174099' },
    { ...repository, workspaceUuid: '123e4567-e89b-12d3-a456-426614174099' },
    { ...repository, fullName: 'acme/other' },
  ] as const)('does not release for cached repository mismatch %#', async resolved => {
    const deps = dependencies();
    deps.findCachedRepository.mockResolvedValue({ status: 'available', repository: resolved });

    await expect(resolveBitbucketToken({} as CloudflareEnv, tokenParams(), deps)).resolves.toEqual({
      success: false,
      reason: 'repository_mismatch',
    });
    expect(deps.authorizationService.invalidateAuthorization).not.toHaveBeenCalled();
  });
});
