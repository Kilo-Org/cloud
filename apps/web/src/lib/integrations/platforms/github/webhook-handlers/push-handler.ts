import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { app_builder_projects, type PlatformIntegration } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { PushEventPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { extractBranchNameFromRef } from '@/lib/integrations/platforms/github/utils';
import { triggerBuild } from '@/lib/app-builder/app-builder-client';

export async function handlePushEvent(event: PushEventPayload, integration: PlatformIntegration) {
  if (integration.github_connection_role !== 'workflow') return;
  const branchName = extractBranchNameFromRef(event.ref);
  const repositoryFullName = event.repository.full_name;

  await rebuildMatchingAppBuilderPreviews(repositoryFullName, branchName, integration);
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
