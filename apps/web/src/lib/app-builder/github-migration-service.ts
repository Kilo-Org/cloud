import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { db } from '@/lib/drizzle';
import { app_builder_projects, deployments, type PlatformIntegration } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import {
  fetchGitHubInstallationDetails,
  fetchGitHubRepositories,
  getInstallationSettingsUrl,
} from '@/lib/integrations/platforms/github/adapter';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import {
  getIntegrationForOwner,
  getIntegrationsByOrganization,
} from '@/lib/integrations/db/platform-integrations';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/project-ownership';
import type {
  MigrateToGitHubInput,
  MigrateToGitHubResult,
  MigrateToGitHubErrorCode,
  CanMigrateToGitHubResult,
  GitHubMigrationTarget,
} from '@/lib/app-builder/types';

class MigrationError extends Error {
  constructor(
    public readonly code: MigrateToGitHubErrorCode,
    options?: ErrorOptions
  ) {
    super(`Migration failed: ${code}`, options);
    this.name = 'MigrationError';
  }
}

function getGitHubAppType(integration: PlatformIntegration): 'standard' | 'lite' {
  return integration.github_app_type ?? 'standard';
}

function getNewRepositoryUrl(accountLogin: string, accountType: string): string {
  return accountType === 'Organization'
    ? `https://github.com/organizations/${accountLogin}/repositories/new`
    : 'https://github.com/new';
}

async function getMigrationIntegrations(owner: Owner): Promise<PlatformIntegration[]> {
  if (owner.type === 'user') {
    const integration = await getIntegrationForOwner(
      owner,
      PLATFORM.GITHUB,
      INTEGRATION_STATUS.ACTIVE
    );
    return integration?.platform_installation_id && isPlatformIntegrationHealthy(integration)
      ? [integration]
      : [];
  }

  const integrations = await getIntegrationsByOrganization(owner.id, PLATFORM.GITHUB);
  return integrations.filter(
    integration =>
      integration.integration_type === 'app' &&
      integration.platform_installation_id !== null &&
      isPlatformIntegrationHealthy(integration)
  );
}

/** Convert a project title to a valid GitHub repository name. */
function titleToRepoName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-') // Replace invalid chars with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .substring(0, 100) // Truncate to 100 chars
    .replace(/^[-.]|[-.]$/g, ''); // Remove leading/trailing hyphens and dots
}

/**
 * Check if a project can be migrated to GitHub.
 * Returns pre-flight information about the migration including available repos.
 *
 * User-created repository approach: Users create empty repos themselves, we push to them.
 * This works for both personal accounts and organizations.
 */
export async function canMigrateToGitHub(
  projectId: string,
  owner: Owner
): Promise<CanMigrateToGitHubResult> {
  const project = await getProjectWithOwnershipCheck(projectId, owner);
  const suggestedRepoName = titleToRepoName(project.title);

  // Default values for when there's no integration
  const noIntegrationResult: CanMigrateToGitHubResult = {
    hasGitHubIntegration: false,
    targetAccountName: null,
    alreadyMigrated: false,
    suggestedRepoName,
    newRepoUrl: 'https://github.com/new',
    installationSettingsUrl: '',
    availableRepos: [],
    repositorySelection: 'all',
    migrationTargets: [],
  };

  // Check if already migrated
  if (project.git_repo_full_name) {
    return {
      hasGitHubIntegration: true,
      targetAccountName: project.git_repo_full_name.split('/')[0] ?? null,
      alreadyMigrated: true,
      suggestedRepoName,
      newRepoUrl: 'https://github.com/new',
      installationSettingsUrl: '',
      availableRepos: [],
      repositorySelection: 'all',
      migrationTargets: [],
    };
  }

  const integrations = await getMigrationIntegrations(owner);
  const integration = integrations[0];
  if (!integration) {
    return noIntegrationResult;
  }

  let targetAccountName = integration.platform_account_login ?? null;
  let installationSettingsUrl = '';
  const integrationData = await Promise.all(
    integrations.map(async candidate => {
      const installationId = candidate.platform_installation_id;
      if (!installationId) return null;

      const appType = getGitHubAppType(candidate);
      try {
        const [installationDetails, settingsUrl, repos] = await Promise.all([
          fetchGitHubInstallationDetails(installationId, appType),
          getInstallationSettingsUrl(installationId, appType),
          fetchGitHubRepositories(installationId, appType),
        ]);
        return { integration: candidate, installationDetails, settingsUrl, repos };
      } catch (error) {
        console.error('Failed to fetch GitHub installation details:', error);
        return null;
      }
    })
  );

  const migrationTargets = integrationData.flatMap<GitHubMigrationTarget>(data => {
    if (!data) return [];

    const platformAccountLogin =
      data.installationDetails.account.login || data.integration.platform_account_login;
    if (!platformAccountLogin) return [];

    const availableRepos = data.repos
      .map(repo => ({
        fullName: repo.full_name,
        createdAt: repo.created_at,
        isPrivate: repo.private,
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);

    return [
      {
        platformIntegrationId: data.integration.id,
        platformAccountLogin,
        githubAppType: getGitHubAppType(data.integration),
        newRepoUrl: getNewRepositoryUrl(
          platformAccountLogin,
          data.installationDetails.account.type
        ),
        installationSettingsUrl: data.settingsUrl,
        availableRepos,
        repositorySelection:
          data.installationDetails.repository_selection === 'selected' ? 'selected' : 'all',
      },
    ];
  });

  const primaryTarget = migrationTargets[0];
  if (primaryTarget) {
    targetAccountName = primaryTarget.platformAccountLogin;
    installationSettingsUrl = primaryTarget.installationSettingsUrl;
  }

  const availableRepos = migrationTargets
    .flatMap(target => target.availableRepos)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  return {
    hasGitHubIntegration: true,
    targetAccountName,
    alreadyMigrated: false,
    suggestedRepoName,
    newRepoUrl: primaryTarget?.newRepoUrl ?? 'https://github.com/new',
    installationSettingsUrl,
    availableRepos,
    repositorySelection: primaryTarget?.repositorySelection ?? 'all',
    migrationTargets,
  };
}

/**
 * Migrate an App Builder project to GitHub.
 *
 * User-created repository approach:
 * 1. User creates empty repo on GitHub themselves
 * 2. User grants Kilo GitHub App access (if using selective repo access)
 * 3. User selects the repo from list of accessible repos
 * 4. Kilo validates the repo is empty and pushes the project code
 *
 * This is a one-way migration that:
 * 1. Validates the target repo exists, is accessible, and is empty
 * 2. Pushes the internal git repository to GitHub
 * 3. Updates the deployment to point to GitHub (if exists)
 * 4. Updates the project record with migration info
 * 5. Deletes the internal repository
 *
 * No rollback needed - since users create the repo, we don't delete it on failure.
 */
export async function migrateProjectToGitHub(
  params: MigrateToGitHubInput
): Promise<MigrateToGitHubResult> {
  const { projectId, owner, userId, repoFullName } = params;

  // 0. Validate ownership (throws NOT_FOUND if project doesn't exist or wrong owner)
  await getProjectWithOwnershipCheck(projectId, owner);

  // 1. Atomically claim this project for migration (prevents concurrent migrations).
  // Keep the claim after any successful Worker response because the push cannot be rolled back.
  const claimStartedAt = new Date().toISOString();
  const [project] = await db
    .update(app_builder_projects)
    .set({ migrated_at: claimStartedAt })
    .where(
      and(
        eq(app_builder_projects.id, projectId),
        isNull(app_builder_projects.migrated_at),
        isNull(app_builder_projects.git_repo_full_name)
      )
    )
    .returning();

  if (!project) {
    const currentProject = await getProjectWithOwnershipCheck(projectId, owner);
    if (
      currentProject.git_repo_full_name === repoFullName &&
      (!params.expectedPlatformIntegrationId ||
        currentProject.git_platform_integration_id === params.expectedPlatformIntegrationId)
    ) {
      return {
        success: true,
        githubRepoUrl: `https://github.com/${repoFullName}`,
        newSessionId: currentProject.session_id ?? '',
      };
    }
    return { success: false, error: 'already_migrated' };
  }

  let releaseClaimOnFailure = true;
  try {
    // 2. Resolve access authoritatively and migrate on the Worker that performs the Git push.
    let platformIntegrationId: string;
    try {
      releaseClaimOnFailure = false;
      const migrateResult = await appBuilderClient.migrateToGithub(projectId, {
        githubRepo: repoFullName,
        userId,
        orgId: owner.type === 'org' ? owner.id : undefined,
        expectedPlatformIntegrationId: params.expectedPlatformIntegrationId,
      });

      if (!migrateResult.success) {
        releaseClaimOnFailure =
          migrateResult.error === 'token_failed' ||
          migrateResult.error === 'repo_not_found' ||
          migrateResult.error === 'repo_not_empty';
        const error =
          migrateResult.error === 'repo_not_found' ||
          migrateResult.error === 'repo_not_empty' ||
          migrateResult.error === 'internal_error'
            ? migrateResult.error
            : 'push_failed';
        throw new MigrationError(error, { cause: migrateResult });
      }
      platformIntegrationId = migrateResult.platformIntegrationId;
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('push_failed', { cause: error });
    }

    // 3. Commit all database state only if this operation still owns the claim.
    await db.transaction(async tx => {
      if (project.deployment_id) {
        await tx
          .update(deployments)
          .set({
            source_type: 'github',
            repository_source: repoFullName,
            platform_integration_id: platformIntegrationId,
          })
          .where(eq(deployments.id, project.deployment_id));
      }

      const [finalizedProject] = await tx
        .update(app_builder_projects)
        .set({
          git_repo_full_name: repoFullName,
          git_platform_integration_id: platformIntegrationId,
        })
        .where(
          and(
            eq(app_builder_projects.id, projectId),
            eq(app_builder_projects.migrated_at, claimStartedAt),
            isNull(app_builder_projects.git_repo_full_name)
          )
        )
        .returning({ id: app_builder_projects.id });

      if (!finalizedProject) {
        throw new Error('GitHub migration claim was lost before finalization');
      }
    });

    return {
      success: true,
      githubRepoUrl: `https://github.com/${repoFullName}`,
      newSessionId: project.session_id ?? '',
    };
  } catch (error) {
    if (releaseClaimOnFailure) {
      await db
        .update(app_builder_projects)
        .set({ migrated_at: null })
        .where(
          and(
            eq(app_builder_projects.id, projectId),
            eq(app_builder_projects.migrated_at, claimStartedAt),
            isNull(app_builder_projects.git_repo_full_name)
          )
        );
    }

    if (error instanceof MigrationError) {
      if (error.cause) {
        console.error(`Migration failed (${error.code}):`, error.cause);
      }
      return { success: false, error: error.code };
    }
    throw error;
  }
}
