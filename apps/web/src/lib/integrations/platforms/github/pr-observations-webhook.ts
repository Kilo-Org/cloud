import 'server-only';

import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { github_branch_pull_requests, platform_integrations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { GitHubAppType } from './app-selector';
import { normalizePrObservationEvent, reducePrObservation } from './pr-observations';

export async function observePrWebhook(input: {
  eventType: string;
  payload: unknown;
  appType: GitHubAppType;
}): Promise<void> {
  const event = normalizePrObservationEvent(input.eventType, input.payload);
  if (!event) return;
  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.platform_installation_id, event.installationId),
        input.appType === 'standard'
          ? or(
              eq(platform_integrations.github_app_type, 'standard'),
              isNull(platform_integrations.github_app_type)
            )
          : eq(platform_integrations.github_app_type, input.appType)
      )
    );
  const gitUrl = normalizeGitUrl(`https://github.com/${event.repository}`);
  for (const integration of integrations) {
    const repositoryAllowed =
      integration.repository_access === 'all' ||
      (integration.repository_access === 'selected' &&
        integration.repositories?.some(
          repo =>
            String(repo.id) === event.repositoryId &&
            repo.full_name.toLowerCase() === event.repository.toLowerCase()
        ));
    if (!repositoryAllowed) continue;
    try {
      await assertGitHubInstallationRuntimeAuthorized(
        event.installationId,
        input.appType,
        integration.id,
        'agent'
      );
    } catch (error) {
      if (error instanceof GitHubRuntimeAuthorizationError) continue;
      throw error;
    }
    const hasOrganization = integration.owned_by_organization_id !== null;
    const hasUser = integration.owned_by_user_id !== null;
    if (hasOrganization === hasUser) continue;
    const ownerCondition =
      integration.owned_by_organization_id !== null
        ? and(
            eq(
              github_branch_pull_requests.owned_by_organization_id,
              integration.owned_by_organization_id
            ),
            isNull(github_branch_pull_requests.owned_by_user_id)
          )
        : integration.owned_by_user_id !== null
          ? and(
              eq(github_branch_pull_requests.owned_by_user_id, integration.owned_by_user_id),
              isNull(github_branch_pull_requests.owned_by_organization_id)
            )
          : undefined;
    if (!ownerCondition) continue;
    const target = and(
      ownerCondition,
      eq(github_branch_pull_requests.git_url, gitUrl),
      isNotNull(github_branch_pull_requests.pr_number),
      event.kind === 'check'
        ? eq(github_branch_pull_requests.pr_head_sha, event.sha)
        : eq(github_branch_pull_requests.pr_number, event.prNumber)
    );
    await db.transaction(async tx => {
      const rows = await tx.select().from(github_branch_pull_requests).where(target).for('update');
      for (const row of rows) {
        if (row.pr_number === null) continue;
        const observations = reducePrObservation(row.pr_observations, row.pr_head_sha, event);
        if (observations === null) continue;
        await tx
          .update(github_branch_pull_requests)
          .set({ pr_observations: observations })
          .where(
            and(
              ownerCondition,
              eq(github_branch_pull_requests.git_url, gitUrl),
              eq(github_branch_pull_requests.pr_number, row.pr_number)
            )
          );
      }
    });
  }
}
