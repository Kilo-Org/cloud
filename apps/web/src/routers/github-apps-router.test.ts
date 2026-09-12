import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import type { PlatformIntegration, User } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import type { UpsertPlatformIntegrationResult } from '@/lib/integrations/db/platform-integrations';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

type TestIntegration = {
  id: string;
  platform_installation_id: string;
  platform_account_login: string;
  github_app_type: GitHubAppType | null;
};

type InstallationDetails = {
  account: { id: number; login: string };
  permissions: Record<string, string>;
  events: string[];
  repository_selection: string;
  created_at: string;
};

const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<TestIntegration | null>>();
const mockUpsertPlatformIntegrationForOwner =
  jest.fn<
    (owner: Owner, details: Record<string, unknown>) => Promise<UpsertPlatformIntegrationResult>
  >();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
const mockFetchGitHubInstallationDetails =
  jest.fn<(installationId: string, appType: GitHubAppType) => Promise<InstallationDetails>>();
const mockFetchGitHubRepositories =
  jest.fn<
    (
      installationId: string,
      appType: GitHubAppType,
      expectedIntegrationId?: string
    ) => Promise<unknown[]>
  >();
const mockSeedUserGithubToken =
  jest.fn<
    (input: Record<string, unknown>) => Promise<{ upserted: boolean; githubLogin: string }>
  >();
const mockListIntegrations = jest.fn<(owner: Owner) => Promise<PlatformIntegration[]>>();
const mockUninstallApp = jest.fn<() => Promise<{ success: boolean; message: string }>>();
const mockEnsureOrganizationAccess =
  jest.fn<
    (
      ctx: { user: User },
      organizationId: string,
      roles?: OrganizationRole[]
    ) => Promise<OrganizationRole>
  >();
const mockGetGitHubAppTypeForOrganization =
  jest.fn<(organizationId: string | null) => Promise<GitHubAppType>>();
const mockCreateInstallState =
  jest.fn<
    (input: {
      kiloUserId: string;
      ownerType: Owner['type'];
      ownerId: string;
      githubAppType: GitHubAppType;
      returnTo: string | null;
    }) => Promise<string>
  >();
const mockObserveGitHubInstallationLifecycle = jest.fn();
const mockBindGitHubIntegrationToCanonicalInstallation = jest.fn();

const mockGetRepositoryCustomizations = jest.fn<
  (
    owner: Owner,
    integrationId: string
  ) => Promise<{
    id: string;
    account: string | null;
    access: string | null;
    defaultModel: string;
    defaultPrReviews: 'on' | 'off';
    repositories: Array<{
      id: number;
      name: string;
      private: boolean;
      model: string | null;
      prReviews: 'on' | 'off' | null;
    }>;
  }>
>();
const mockUpdateInstallationSettings =
  jest.fn<
    (
      owner: Owner,
      integrationId: string,
      settings: { modelSlug?: string; prReviewMode?: 'on' | 'off' }
    ) => Promise<{ success: boolean; error?: string }>
  >();
const mockUpdateRepositorySettings =
  jest.fn<
    (
      owner: Owner,
      integrationId: string,
      repositoryId: number,
      settings: { modelSlug?: string | null; prReviewMode?: 'on' | 'off' | null }
    ) => Promise<{ success: boolean; error?: string }>
  >();

jest.mock('@/lib/integrations/github-apps-service', () => ({
  listIntegrations: (owner: Owner) => mockListIntegrations(owner),
  uninstallApp: () => mockUninstallApp(),
  getRepositoryCustomizations: (owner: Owner, integrationId: string) =>
    mockGetRepositoryCustomizations(owner, integrationId),
  updateInstallationSettings: (
    owner: Owner,
    integrationId: string,
    settings: Parameters<typeof mockUpdateInstallationSettings>[2]
  ) => mockUpdateInstallationSettings(owner, integrationId, settings),
  updateRepositorySettings: (
    owner: Owner,
    integrationId: string,
    repositoryId: number,
    settings: Parameters<typeof mockUpdateRepositorySettings>[3]
  ) => mockUpdateRepositorySettings(owner, integrationId, repositoryId, settings),
}));

jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: (
    ctx: { user: User },
    organizationId: string,
    roles?: OrganizationRole[]
  ) => mockEnsureOrganizationAccess(ctx, organizationId, roles),
}));

jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: jest.fn(),
  getGitHubAppTypeForOrganization: (organizationId: string | null) =>
    mockGetGitHubAppTypeForOrganization(organizationId),
}));

jest.mock('@/lib/integrations/github/install-state', () => ({
  createInstallState: (input: Parameters<typeof mockCreateInstallState>[0]) =>
    mockCreateInstallState(input),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (owner: Owner, platform: string) =>
    mockGetIntegrationForOwner(owner, platform),
  getGitHubIntegrationById: (_owner: Owner, _integrationId: string) =>
    mockGetIntegrationForOwner(_owner, 'github'),
  upsertPlatformIntegrationForOwner: (owner: Owner, details: Record<string, unknown>) =>
    mockUpsertPlatformIntegrationForOwner(owner, details),
  updateRepositoriesForIntegration: (integrationId: string, repositories: unknown[]) =>
    mockUpdateRepositoriesForIntegration(integrationId, repositories),
}));
jest.mock('@/lib/integrations/db/github-installations', () => ({
  disconnectGitHubInstallation: jest.fn(),
  bindGitHubIntegrationToCanonicalInstallation: (input: unknown) =>
    mockBindGitHubIntegrationToCanonicalInstallation(input),
  observeGitHubInstallationLifecycle: (input: unknown) =>
    mockObserveGitHubInstallationLifecycle(input),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: (installationId: string, appType: GitHubAppType) =>
    mockFetchGitHubInstallationDetails(installationId, appType),
  fetchGitHubRepositories: (
    installationId: string,
    appType: GitHubAppType,
    expectedIntegrationId?: string
  ) => mockFetchGitHubRepositories(installationId, appType, expectedIntegrationId),
}));

jest.mock('@/lib/github-pr-review/dev-seed', () => ({
  seedUserGithubToken: (...args: [Record<string, unknown>]) => mockSeedUserGithubToken(...args),
}));

let createCaller: (ctx: { user: User }) => {
  listOrganizationInstallations: (input: { organizationId: string }) => Promise<{
    canAdd: boolean;
    canConnectExisting: boolean;
    existingConnectionAdmission: {
      allowed: boolean;
      reason:
        | 'not_authorized'
        | 'sharing_not_approved'
        | 'multiple_installations_not_approved'
        | null;
    };
    installations: Array<{ id: string }>;
  }>;
  mintInstallState: (input: {
    organizationId?: string;
    returnTo?: string;
  }) => Promise<{ token: string }>;
  refreshInstallation: (input?: { organizationId?: string }) => Promise<{ success: boolean }>;
  devSeedUserGithubToken: (input: {
    token: string;
    githubLogin: string;
    githubUserId: string;
  }) => Promise<{ success: boolean; githubLogin: string }>;
  uninstallApp: (input: {
    organizationId?: string;
    integrationId?: string;
  }) => Promise<{ success: boolean }>;
  beginConnection: (input: { organizationId: string }) => Promise<{ authorizationUrl: string }>;
  getConnectionAttempt: (input: { organizationId: string; attemptId: string }) => Promise<unknown>;
  selectConnectionInstallation: (input: {
    attemptId: string;
    installationId: string;
  }) => Promise<{ authorizationUrl: string }>;
  disconnectConnection: (input: {
    organizationId: string;
    integrationId: string;
  }) => Promise<{ success: boolean }>;
  getRepositoryCustomizations: (input: {
    organizationId?: string;
    integrationId: string;
  }) => Promise<{
    id: string;
    account: string | null;
    access: string | null;
    defaultModel: string;
    defaultPrReviews: 'on' | 'off';
    repositories: Array<{
      id: number;
      name: string;
      private: boolean;
      model: string | null;
      prReviews: 'on' | 'off' | null;
    }>;
  }>;
  updateInstallationSettings: (input: {
    organizationId?: string;
    integrationId: string;
    settings: { modelSlug?: string; prReviewMode?: 'on' | 'off' };
  }) => Promise<{ success: boolean; error?: string }>;
  updateRepositorySettings: (input: {
    organizationId?: string;
    integrationId: string;
    repositoryId: number;
    settings: { modelSlug?: string | null; prReviewMode?: 'on' | 'off' | null };
  }) => Promise<{ success: boolean; error?: string }>;
};

beforeAll(async () => {
  const mod = await import('./github-apps-router');
  createCaller = createCallerFactory(mod.githubAppsRouter);
});

const organizationId = '00000000-0000-4000-8000-000000000001';
const multiInstallationOrganizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
const integrationId = '00000000-0000-4000-8000-000000000002';
const organizationRoles = [
  'owner',
  'admin',
  'billing_manager',
  'member',
] satisfies OrganizationRole[];
const organizationManageRoles = ['owner', 'admin'] satisfies OrganizationRole[];

function organizationIntegration(): PlatformIntegration {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    id: integrationId,
    owned_by_organization_id: organizationId,
    owned_by_user_id: null,
    created_by_user_id: 'user-1',
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: '98765',
    platform_account_id: '123',
    platform_account_login: 'existing-org',
    permissions: null,
    scopes: [],
    repository_access: 'all',
    repositories: [],
    repositories_synced_at: null,
    auth_invalid_at: null,
    auth_invalid_reason: null,
    metadata: null,
    kilo_requester_user_id: 'user-1',
    platform_requester_account_id: null,
    integration_status: 'active',
    suspended_at: null,
    suspended_by: null,
    github_app_type: 'standard',
    github_installation_id: null,
    github_disconnected_at: null,
    github_authorized_by_user_id: null,
    github_authorized_user_id: null,
    github_authorized_at: null,
    installed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe('githubAppsRouter organization install capability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GITHUB_CONNECTION_MANAGEMENT_ENABLED = 'true';
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS =
      '9d278969-5453-4ae3-a51f-a8d2274a7b56,30f1620a-4aad-4456-bf4d-550f335e6f55';
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = '';
    mockEnsureOrganizationAccess.mockResolvedValue('member');
    mockGetGitHubAppTypeForOrganization.mockResolvedValue('standard');
    mockCreateInstallState.mockResolvedValue('install-token');
    mockListIntegrations.mockResolvedValue([]);
    mockUninstallApp.mockResolvedValue({ success: true, message: 'GitHub App uninstalled' });
  });

  it.each(organizationManageRoles)(
    'allows organization %s roles to start an install',
    async role => {
      mockEnsureOrganizationAccess.mockResolvedValue(role);
      const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

      await expect(caller.mintInstallState({ organizationId })).resolves.toEqual({
        token: 'install-token',
      });

      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
        organizationId,
        organizationManageRoles
      );
      expect(mockCreateInstallState).toHaveBeenCalledWith({
        kiloUserId: 'user-1',
        ownerType: 'org',
        ownerId: organizationId,
        githubAppType: 'standard',
        returnTo: null,
      });
    }
  );

  it.each(['billing_manager', 'member'] satisfies OrganizationRole[])(
    'denies organization %s roles before minting install state',
    async role => {
      mockEnsureOrganizationAccess.mockImplementation(async (_ctx, _organizationId, roles) => {
        if (roles && !roles.includes(role)) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization role required' });
        }
        return role;
      });
      const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

      await expect(caller.mintInstallState({ organizationId })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });

      expect(mockCreateInstallState).not.toHaveBeenCalled();
    }
  );

  it.each(organizationRoles)(
    'reports first-install capability for organization %s roles',
    async role => {
      mockEnsureOrganizationAccess.mockResolvedValue(role);
      const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

      const listed = await caller.listOrganizationInstallations({ organizationId });

      expect(listed.canAdd).toBe(role === 'owner' || role === 'admin');
      expect(listed.canConnectExisting).toBe(false);
      expect(listed.installations).toHaveLength(0);
    }
  );

  it('hides additional installation capability for organizations outside the allowlist', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListIntegrations.mockResolvedValue([organizationIntegration()]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    const listed = await caller.listOrganizationInstallations({ organizationId });

    expect(listed.canAdd).toBe(false);
    expect(listed.installations).toHaveLength(1);
  });

  it('does not let a locally disconnected connection block adding another installation', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListIntegrations.mockResolvedValue([
      { ...organizationIntegration(), github_disconnected_at: '2026-01-02T00:00:00.000Z' },
    ]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    const listed = await caller.listOrganizationInstallations({ organizationId });

    expect(listed.canAdd).toBe(true);
    expect(listed.installations).toHaveLength(1);
    expect(listed.installations[0]).toMatchObject({ status: 'disconnected' });
  });

  it('does not let a locally disconnected connection block starting a fresh connect-existing flow', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationId;
    mockListIntegrations.mockResolvedValue([
      { ...organizationIntegration(), github_disconnected_at: '2026-01-02T00:00:00.000Z' },
    ]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    const listed = await caller.listOrganizationInstallations({ organizationId });

    expect(listed.canConnectExisting).toBe(true);
    expect(listed.existingConnectionAdmission).toEqual({ allowed: true, reason: null });
  });

  it('reports additional installation capability for allowlisted organizations', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = multiInstallationOrganizationId;
    mockListIntegrations.mockResolvedValue([
      { ...organizationIntegration(), owned_by_organization_id: multiInstallationOrganizationId },
    ]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    const listed = await caller.listOrganizationInstallations({
      organizationId: multiInstallationOrganizationId,
    });

    expect(listed.canAdd).toBe(true);
    expect(listed.existingConnectionAdmission).toEqual({ allowed: true, reason: null });
  });

  it('reports why an existing connection cannot be started without both destination flags', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListIntegrations.mockResolvedValue([organizationIntegration()]);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationId;
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = '';
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    const listed = await caller.listOrganizationInstallations({ organizationId });

    expect(listed.canConnectExisting).toBe(false);
    expect(listed.existingConnectionAdmission).toEqual({
      allowed: false,
      reason: 'multiple_installations_not_approved',
    });
  });

  it('refuses to mint another install state outside the allowlist', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListIntegrations.mockResolvedValue([organizationIntegration()]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(caller.mintInstallState({ organizationId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockCreateInstallState).not.toHaveBeenCalled();
  });

  it('mints an install state when the only existing connection is locally disconnected', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListIntegrations.mockResolvedValue([
      { ...organizationIntegration(), github_disconnected_at: '2026-01-02T00:00:00.000Z' },
    ]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(caller.mintInstallState({ organizationId })).resolves.toEqual({
      token: 'install-token',
    });
    expect(mockCreateInstallState).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: organizationId })
    );
  });

  it('mints another install state for an allowlisted organization', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListIntegrations.mockResolvedValue([
      { ...organizationIntegration(), owned_by_organization_id: multiInstallationOrganizationId },
    ]);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.mintInstallState({ organizationId: multiInstallationOrganizationId })
    ).resolves.toEqual({ token: 'install-token' });
    expect(mockCreateInstallState).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: multiInstallationOrganizationId })
    );
  });

  it('still denies callers outside the organization role matrix before minting state', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization access required' })
    );
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(caller.mintInstallState({ organizationId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    expect(mockGetGitHubAppTypeForOrganization).not.toHaveBeenCalled();
    expect(mockCreateInstallState).not.toHaveBeenCalled();
  });

  it('preserves upstream uninstall behavior while connection management is disabled', async () => {
    delete process.env.GITHUB_CONNECTION_MANAGEMENT_ENABLED;
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    const caller = createCaller({
      user: {
        id: 'user-1',
        google_user_email: 'owner@example.com',
        google_user_name: 'Owner',
      } as User,
    });
    await expect(caller.uninstallApp({ organizationId, integrationId })).resolves.toMatchObject({
      success: true,
    });
    expect(mockUninstallApp).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'begin',
      (caller: ReturnType<typeof createCaller>) => caller.beginConnection({ organizationId }),
    ],
    [
      'read',
      (caller: ReturnType<typeof createCaller>) =>
        caller.getConnectionAttempt({ organizationId, attemptId: integrationId }),
    ],
    [
      'select',
      (caller: ReturnType<typeof createCaller>) =>
        caller.selectConnectionInstallation({ attemptId: integrationId, installationId: '98765' }),
    ],
    [
      'disconnect',
      (caller: ReturnType<typeof createCaller>) =>
        caller.disconnectConnection({ organizationId, integrationId }),
    ],
  ])('forbids %s connection management while the flag is off', async (_name, invoke) => {
    delete process.env.GITHUB_CONNECTION_MANAGEMENT_ENABLED;
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    await expect(invoke(caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('githubAppsRouter.refreshInstallation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIntegrationForOwner.mockResolvedValue({
      id: 'integration-1',
      platform_installation_id: '98765',
      platform_account_login: 'old-owner',
      github_app_type: 'standard',
    });
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 123, login: 'renamed-owner' },
      permissions: {},
      events: [],
      repository_selection: 'all',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    mockFetchGitHubRepositories.mockResolvedValue([]);
    mockUpsertPlatformIntegrationForOwner.mockResolvedValue({ ok: true });
    mockUpdateRepositoriesForIntegration.mockResolvedValue(undefined);
  });

  it('refreshes the selected association through canonical installation state', async () => {
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await caller.refreshInstallation();

    expect(mockObserveGitHubInstallationLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: '98765',
        accountLogin: 'renamed-owner',
        state: 'active',
      })
    );
    expect(mockBindGitHubIntegrationToCanonicalInstallation).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      installationId: '98765',
      appType: 'standard',
    });
    expect(mockFetchGitHubRepositories).toHaveBeenCalledWith('98765', 'standard', 'integration-1');
  });

  it('does not clear stored identity when GitHub returns no current account login', async () => {
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 0, login: '' },
      permissions: {},
      events: [],
      repository_selection: 'all',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await expect(caller.refreshInstallation()).rejects.toThrow(
      'GitHub installation account identity unavailable'
    );

    expect(mockObserveGitHubInstallationLifecycle).not.toHaveBeenCalled();
    expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
  });

  it('canonically binds an unbound legacy Standard row during refresh', async () => {
    mockGetIntegrationForOwner.mockResolvedValue({
      id: 'integration-1',
      platform_installation_id: '98765',
      platform_account_login: 'old-owner',
      github_app_type: null,
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });
    await caller.refreshInstallation();
    expect(mockBindGitHubIntegrationToCanonicalInstallation).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      installationId: '98765',
      appType: 'standard',
    });
  });
});

describe('githubAppsRouter.devSeedUserGithubToken', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    Object.assign(process.env, { NODE_ENV: originalNodeEnv });
  });

  it('throws FORBIDDEN when NODE_ENV is not development', async () => {
    Object.assign(process.env, { NODE_ENV: 'production' });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await expect(
      caller.devSeedUserGithubToken({
        token: 'fake-token',
        githubLogin: 'octocat',
        githubUserId: '42',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockSeedUserGithubToken).not.toHaveBeenCalled();
  });

  it('in development, encrypts + upserts the row for ctx.user', async () => {
    Object.assign(process.env, { NODE_ENV: 'development' });
    mockSeedUserGithubToken.mockResolvedValueOnce({ upserted: true, githubLogin: 'octocat' });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const result = await caller.devSeedUserGithubToken({
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });

    expect(result).toEqual({ success: true, githubLogin: 'octocat' });
    expect(mockSeedUserGithubToken).toHaveBeenCalledWith({
      kiloUserId: 'user-1',
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });
  });

  it('returns success=false when the helper reports no row was upserted', async () => {
    Object.assign(process.env, { NODE_ENV: 'development' });
    mockSeedUserGithubToken.mockResolvedValueOnce({ upserted: false, githubLogin: 'octocat' });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const result = await caller.devSeedUserGithubToken({
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });

    expect(result.success).toBe(false);
    expect(result.githubLogin).toBe('octocat');
  });
});

describe('githubAppsRouter.getRepositoryCustomizations', () => {
  const customizations = {
    id: integrationId,
    account: 'acme',
    access: 'all',
    defaultModel: 'model-a',
    defaultPrReviews: 'on' as const,
    repositories: [{ id: 1, name: 'acme/repo', private: false, model: null, prReviews: null }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRepositoryCustomizations.mockResolvedValue(customizations);
  });

  it('forwards the resolved personal owner and integrationId to the service', async () => {
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const result = await caller.getRepositoryCustomizations({ integrationId });

    expect(result).toEqual(customizations);
    expect(mockGetRepositoryCustomizations).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      integrationId
    );
  });

  it('checks organization access before forwarding the organization owner', async () => {
    mockEnsureOrganizationAccess.mockResolvedValue('member');
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await caller.getRepositoryCustomizations({ organizationId, integrationId });

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
      organizationId,
      undefined
    );
    expect(mockGetRepositoryCustomizations).toHaveBeenCalledWith(
      { type: 'org', id: organizationId },
      integrationId
    );
  });

  it('denies organization access before contacting the service', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization access required' })
    );
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.getRepositoryCustomizations({ organizationId, integrationId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockGetRepositoryCustomizations).not.toHaveBeenCalled();
  });
});

describe('githubAppsRouter.updateInstallationSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateInstallationSettings.mockResolvedValue({ success: true });
  });

  it('forwards the resolved personal owner and settings to the service', async () => {
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const result = await caller.updateInstallationSettings({
      integrationId,
      settings: { prReviewMode: 'off' },
    });

    expect(result).toEqual({ success: true });
    expect(mockUpdateInstallationSettings).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      integrationId,
      { prReviewMode: 'off' }
    );
  });

  it.each(['owner', 'admin', 'billing_manager'] satisfies OrganizationRole[])(
    'allows organization %s roles to update installation settings',
    async role => {
      mockEnsureOrganizationAccess.mockResolvedValue(role);
      const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

      await caller.updateInstallationSettings({
        organizationId,
        integrationId,
        settings: { modelSlug: 'model-b' },
      });

      expect(mockUpdateInstallationSettings).toHaveBeenCalledWith(
        { type: 'org', id: organizationId },
        integrationId,
        { modelSlug: 'model-b' }
      );
    }
  );

  it('denies organization member role before contacting the service', async () => {
    mockEnsureOrganizationAccess.mockImplementation(async (_ctx, _organizationId, roles) => {
      if (roles && !roles.includes('member')) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization role required' });
      }
      return 'member';
    });
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.updateInstallationSettings({
        organizationId,
        integrationId,
        settings: { modelSlug: 'model-b' },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockUpdateInstallationSettings).not.toHaveBeenCalled();
  });
});

describe('githubAppsRouter.updateRepositorySettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateRepositorySettings.mockResolvedValue({ success: true });
  });

  it('forwards the resolved personal owner, integrationId, repositoryId, and settings', async () => {
    const caller = createCaller({ user: { id: 'user-1' } as User });

    const result = await caller.updateRepositorySettings({
      integrationId,
      repositoryId: 1,
      settings: { modelSlug: null, prReviewMode: 'off' },
    });

    expect(result).toEqual({ success: true });
    expect(mockUpdateRepositorySettings).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      integrationId,
      1,
      { modelSlug: null, prReviewMode: 'off' }
    );
  });

  it('denies organization member role before contacting the service', async () => {
    mockEnsureOrganizationAccess.mockImplementation(async (_ctx, _organizationId, roles) => {
      if (roles && !roles.includes('member')) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization role required' });
      }
      return 'member';
    });
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.updateRepositorySettings({
        organizationId,
        integrationId,
        repositoryId: 1,
        settings: { prReviewMode: 'off' },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockUpdateRepositorySettings).not.toHaveBeenCalled();
  });
});
