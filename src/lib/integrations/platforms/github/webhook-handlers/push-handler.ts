import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import {
  deployments,
  platform_integrations,
  app_builder_projects,
  type PlatformIntegration,
} from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { redeploy } from '@/lib/user-deployments/deployments-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import type { PushEventPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { extractBranchNameFromRef } from '@/lib/integrations/platforms/github/utils';
import { triggerBuild } from '@/lib/app-builder/app-builder-client';

export async function handlePushEvent(event: PushEventPayload, integration: PlatformIntegration) {
  const branchName = extractBranchNameFromRef(event.ref);
  const repositoryFullName = event.repository.full_name;

  await Promise.allSettled([
    redeployMatchingDeployments(repositoryFullName, branchName),
    rebuildMatchingAppBuilderPreviews(repositoryFullName, branchName, integration),
  ]);
}

async function redeployMatchingDeployments(repositoryFullName: string, branchName: string) {
  const githubDeployments = await db
    .select({
      deployment: deployments,
      integration: platform_integrations,
    })
    .from(deployments)
    .innerJoin(
      platform_integrations,
      eq(deployments.platform_integration_id, platform_integrations.id)
    )
    .where(
      and(
        eq(deployments.repository_source, repositoryFullName),
        eq(deployments.branch, branchName),
        eq(deployments.source_type, 'github'),
        eq(platform_integrations.platform, PLATFORM.GITHUB)
      )
    );

  if (githubDeployments.length === 0) {
    logExceptInTest('No matching deployments found for push event', {
      repository: repositoryFullName,
      branch: branchName,
    });
    return;
  }

  await Promise.allSettled(
    githubDeployments.map(async ({ deployment }) => {
      try {
        await redeploy(deployment);
      } catch (error) {
        logExceptInTest('Failed to trigger redeployment', {
          deploymentId: deployment.id,
          error: error instanceof Error ? error.message : String(error),
        });
        captureException(error, {
          tags: {
            source: 'github_webhook_handler',
            event: 'push',
            deploymentId: deployment.id,
          },
          extra: {
            repository: repositoryFullName,
            branch: branchName,
          },
        });
      }
    })
  );
}

async function rebuildMatchingAppBuilderPreviews(
  repositoryFullName: string,
  branchName: string,
  integration: PlatformIntegration
) {
  if (branchName !== 'main') return;

  const projects = await db
    .select({ id: app_builder_projects.id })
    .from(app_builder_projects)
    .where(
      and(
        eq(app_builder_projects.git_repo_full_name, repositoryFullName),
        eq(app_builder_projects.git_platform_integration_id, integration.id)
      )
    );

  if (projects.length === 0) return;

  await Promise.allSettled(
    projects.map(async ({ id }) => {
      try {
        await triggerBuild(id);
      } catch (error) {
        logExceptInTest('Failed to trigger app builder preview rebuild', {
          projectId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        captureException(error, {
          tags: {
            source: 'github_webhook_handler',
            event: 'push',
            projectId: id,
          },
          extra: {
            repository: repositoryFullName,
            branch: branchName,
          },
        });
      }
    })
  );
}
