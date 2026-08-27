import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { deployments, kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';

const mockGenerateGitHubInstallationToken = jest.fn();
const mockCreateDeployment = jest.fn();
const mockSetSlugMapping = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (
    installationId: string,
    appType: string,
    repositoryName?: string
  ) => mockGenerateGitHubInstallationToken(installationId, appType, repositoryName),
}));

jest.mock('@/lib/user-deployments/deployment-builder-client', () => ({
  apiClient: {
    createDeployment: (...args: unknown[]) => mockCreateDeployment(...args),
  },
}));

jest.mock('@/lib/creditTransactions', () => ({
  hasUserEverPaid: jest.fn().mockResolvedValue(true),
  hasOrganizationEverPaid: jest.fn().mockResolvedValue(true),
}));

jest.mock('@/lib/user-deployments/dispatcher-client', () => ({
  DispatcherSlugTakenError: class DispatcherSlugTakenError extends Error {},
  dispatcherClient: {
    setSlugMapping: (...args: unknown[]) => mockSetSlugMapping(...args),
    deleteSlugMapping: jest.fn(),
  },
}));

import { createDeployment, redeploy } from './deployments-service';

describe('deployment GitHub token selection', () => {
  let ownerUserId: string;
  let integrationId: string;
  let deploymentId: string;

  beforeAll(async () => {
    const owner = await insertTestUser();
    ownerUserId = owner.id;

    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerUserId,
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        platform_installation_id: `lite-${crypto.randomUUID()}`,
        github_app_type: 'lite',
        repository_access: 'selected',
        repositories: [
          {
            id: 1,
            name: 'stale-positive',
            full_name: 'acme/stale-positive',
            private: true,
          },
        ],
      })
      .returning();
    integrationId = integration.id;

    const [deployment] = await db
      .insert(deployments)
      .values({
        owned_by_user_id: ownerUserId,
        deployment_slug: `token-${crypto.randomUUID()}`,
        internal_worker_name: `dpl-${crypto.randomUUID()}`,
        repository_source: 'acme/lite-repo',
        branch: 'main',
        deployment_url: `https://${crypto.randomUUID()}.example.com`,
        platform_integration_id: integrationId,
        source_type: 'github',
        last_build_id: crypto.randomUUID(),
        created_from: 'deploy',
      })
      .returning();
    deploymentId = deployment.id;
  });

  afterAll(async () => {
    await db.delete(deployments).where(eq(deployments.owned_by_user_id, ownerUserId));
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ownerUserId));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateGitHubInstallationToken.mockResolvedValue({
      token: 'lite-installation-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    mockCreateDeployment.mockResolvedValue({ buildId: crypto.randomUUID(), status: 'queued' });
    mockSetSlugMapping.mockResolvedValue({ success: true });
  });

  it('mints redeployment credentials with the integration app type', async () => {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    await redeploy(deployment);

    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith(
      expect.stringMatching(/^lite-/),
      'lite',
      'lite-repo'
    );
    expect(mockCreateDeployment).toHaveBeenCalledWith(
      'github',
      'acme/lite-repo',
      deployment.internal_worker_name,
      'main',
      'lite-installation-token',
      undefined,
      undefined
    );
  });

  it('lets GitHub authorize a repository missing from the selected-repository cache', async () => {
    await createDeployment({
      owner: { type: 'user', id: ownerUserId },
      source: {
        type: 'github',
        platformIntegrationId: integrationId,
        repositoryFullName: 'acme/stale-negative',
      },
      branch: 'main',
      createdByUserId: ownerUserId,
      createdFrom: 'deploy',
    });

    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith(
      expect.stringMatching(/^lite-/),
      'lite',
      'stale-negative'
    );
    expect(mockCreateDeployment).toHaveBeenCalledWith(
      'github',
      'acme/stale-negative',
      expect.stringMatching(/^dpl-/),
      'main',
      'lite-installation-token',
      undefined,
      undefined
    );
  });

  it('lets GitHub reject a repository still present in the selected-repository cache', async () => {
    mockGenerateGitHubInstallationToken.mockRejectedValueOnce(
      new Error('Repository is not accessible to this installation')
    );

    await expect(
      createDeployment({
        owner: { type: 'user', id: ownerUserId },
        source: {
          type: 'github',
          platformIntegrationId: integrationId,
          repositoryFullName: 'acme/stale-positive',
        },
        branch: 'main',
        createdByUserId: ownerUserId,
        createdFrom: 'deploy',
      })
    ).rejects.toThrow('Repository is not accessible to this installation');

    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith(
      expect.stringMatching(/^lite-/),
      'lite',
      'stale-positive'
    );
    expect(mockCreateDeployment).not.toHaveBeenCalled();
  });
});
