import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { deployments, kilocode_users, platform_integrations } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';

const mockGenerateGitHubInstallationToken = jest.fn();
const mockCreateDeployment = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (installationId: string, appType: string) =>
    mockGenerateGitHubInstallationToken(installationId, appType),
}));

jest.mock('@/lib/user-deployments/deployment-builder-client', () => ({
  apiClient: {
    createDeployment: (...args: unknown[]) => mockCreateDeployment(...args),
  },
}));

import { redeploy } from './deployments-service';

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
    await db.delete(deployments).where(eq(deployments.id, deploymentId));
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
  });

  it('mints redeployment credentials with the integration app type', async () => {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    await redeploy(deployment);

    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith(
      expect.stringMatching(/^lite-/),
      'lite'
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
});
