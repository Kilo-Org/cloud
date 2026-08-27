import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  app_builder_projects,
  deployments,
  kilocode_users,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';

const mockRedeploy = jest.fn();
const mockTriggerBuild = jest.fn();

jest.mock('@/lib/user-deployments/deployments-service', () => ({
  redeploy: (deployment: unknown) => mockRedeploy(deployment),
}));

jest.mock('@/lib/app-builder/app-builder-client', () => ({
  triggerBuild: (projectId: string) => mockTriggerBuild(projectId),
}));

import { handlePushEvent } from './push-handler';

describe('GitHub push deployment dispatch', () => {
  const integrationIds: string[] = [];
  const deploymentIds: string[] = [];
  const projectIds: string[] = [];
  let ownerUserId: string;
  let organizationId: string;

  beforeAll(async () => {
    const owner = await insertTestUser();
    ownerUserId = owner.id;
    const organization = await createTestOrganization(
      `push-dispatch-${crypto.randomUUID()}`,
      ownerUserId,
      0
    );
    organizationId = organization.id;
  });

  afterAll(async () => {
    if (projectIds.length > 0) {
      await db.delete(app_builder_projects).where(inArray(app_builder_projects.id, projectIds));
    }
    if (deploymentIds.length > 0) {
      await db.delete(deployments).where(inArray(deployments.id, deploymentIds));
    }
    if (integrationIds.length > 0) {
      await db
        .delete(platform_integrations)
        .where(inArray(platform_integrations.id, integrationIds));
    }
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, ownerUserId));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedeploy.mockResolvedValue(undefined);
    mockTriggerBuild.mockResolvedValue(undefined);
  });

  async function createIntegration(installationId: string) {
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organizationId,
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        platform_installation_id: installationId,
        github_app_type: 'standard',
      })
      .returning();
    integrationIds.push(integration.id);
    return integration;
  }

  async function createDeployment(integrationId: string, branch: string) {
    const [deployment] = await db
      .insert(deployments)
      .values({
        owned_by_organization_id: organizationId,
        deployment_slug: `push-${crypto.randomUUID()}`,
        internal_worker_name: `dpl-${crypto.randomUUID()}`,
        repository_source: 'acme/widgets',
        branch,
        deployment_url: `https://${crypto.randomUUID()}.example.com`,
        platform_integration_id: integrationId,
        source_type: 'github',
        last_build_id: crypto.randomUUID(),
        created_from: 'deploy',
      })
      .returning();
    deploymentIds.push(deployment.id);
    return deployment;
  }

  async function createAppBuilderProject(integrationId: string) {
    const [project] = await db
      .insert(app_builder_projects)
      .values({
        owned_by_organization_id: organizationId,
        title: `Project ${crypto.randomUUID()}`,
        model_id: 'test-model',
        git_repo_full_name: 'acme/widgets',
        git_platform_integration_id: integrationId,
      })
      .returning();
    projectIds.push(project.id);
    return project;
  }

  it('dispatches overlapping repository rows only for the event integration', async () => {
    const eventIntegration = await createIntegration(`event-${crypto.randomUUID()}`);
    const siblingIntegration = await createIntegration(`sibling-${crypto.randomUUID()}`);
    const matchingDeployment = await createDeployment(eventIntegration.id, 'main');
    await createDeployment(siblingIntegration.id, 'main');
    await createDeployment(eventIntegration.id, 'release');
    const matchingProject = await createAppBuilderProject(eventIntegration.id);
    await createAppBuilderProject(siblingIntegration.id);

    await handlePushEvent(
      {
        ref: 'refs/heads/main',
        repository: { full_name: 'acme/widgets' },
        deleted: false,
      },
      eventIntegration
    );

    expect(mockRedeploy).toHaveBeenCalledTimes(1);
    expect(mockRedeploy).toHaveBeenCalledWith(
      expect.objectContaining({ id: matchingDeployment.id })
    );
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    expect(mockTriggerBuild).toHaveBeenCalledWith(matchingProject.id);
  });

  it('preserves main-only App Builder preview rebuilds', async () => {
    const eventIntegration = await createIntegration(`feature-${crypto.randomUUID()}`);
    const matchingDeployment = await createDeployment(eventIntegration.id, 'feature/one');
    await createAppBuilderProject(eventIntegration.id);

    await handlePushEvent(
      {
        ref: 'refs/heads/feature/one',
        repository: { full_name: 'acme/widgets' },
        deleted: false,
      },
      eventIntegration
    );

    expect(mockRedeploy).toHaveBeenCalledTimes(1);
    expect(mockRedeploy).toHaveBeenCalledWith(
      expect.objectContaining({ id: matchingDeployment.id })
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });
});
