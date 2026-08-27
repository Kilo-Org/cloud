import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { db } from '@/lib/drizzle';
import { app_builder_projects, deployments, type PlatformIntegration } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import {
  fetchGitHubInstallationDetails,
  fetchGitHubRepositories,
  getRepositoryDetails,
  getInstallationSettingsUrl,
} from '@/lib/integrations/platforms/github/adapter';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import {
  getIntegrationForOwner,
  getIntegrationsByOrganization,
  resolveOrganizationGitHubIntegrationForRepository,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/project-ownership';
import type {
  MigrateToGitHubInput,
  MigrateToGitHubResult,
  MigrateToGitHubErrorCode,
  CanMigrateToGitHubResult,
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

async function getMigrationIntegrations(owner: Owner): Promise<PlatformIntegration[]> {
  if (owner.type === 'user') {
    const integration = await getIntegrationForOwner(
      owner,
      PLATFORM.GITHUB,
      INTEGRATION_STATUS.ACTIVE
    );
    return integration?.platform_installation_id ? [integration] : [];
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
    };
  }

  const integrations = await getMigrationIntegrations(owner);
  const integration = integrations[0];
  if (!integration?.platform_installation_id) {
    return noIntegrationResult;
  }

  // Fetch installation details and available repos in parallel
  let targetAccountName = integration.platform_account_login ?? null;
  let installationSettingsUrl = '';
  let availableRepos: CanMigrateToGitHubResult['availableRepos'] = [];
  let accountType = 'User';
  let repositorySelection: 'all' | 'selected' = 'all';

  const integrationData = await Promise.all(
    integrations.map(async candidate => {
      const candidateInstallationId = candidate.platform_installation_id;
      if (!candidateInstallationId) return null;
      const appType = getGitHubAppType(candidate);
      try {
        const [installationDetails, settingsUrl, repos] = await Promise.all([
          fetchGitHubInstallationDetails(candidateInstallationId, appType),
          getInstallationSettingsUrl(candidateInstallationId, appType),
          fetchGitHubRepositories(candidateInstallationId, appType),
        ]);
        await updateRepositoriesForIntegration(candidate.id, repos);
        return { integration: candidate, installationDetails, settingsUrl, repos };
      } catch (error) {
        console.error('Failed to fetch GitHub installation details:', error);
        return null;
      }
    })
  );

  const primaryData = integrationData[0];
  if (primaryData) {
    targetAccountName = primaryData.installationDetails.account.login || targetAccountName;
    accountType = primaryData.installationDetails.account.type;
    repositorySelection =
      primaryData.installationDetails.repository_selection === 'selected' ? 'selected' : 'all';
    installationSettingsUrl = primaryData.settingsUrl;
  }

  const reposByFullName = new Map<string, CanMigrateToGitHubResult['availableRepos']>();
  for (const data of integrationData) {
    if (!data) continue;
    for (const repo of data.repos) {
      const key = repo.full_name.toLowerCase();
      const matches = reposByFullName.get(key) ?? [];
      matches.push({
        fullName: repo.full_name,
        createdAt: repo.created_at,
        isPrivate: repo.private,
        platformIntegrationId: data.integration.id,
      });
      reposByFullName.set(key, matches);
    }
  }
  availableRepos = [...reposByFullName.values()]
    .map(matches => {
      const [repo] = matches;
      if (!repo) return null;
      return matches.length === 1 ? repo : { ...repo, platformIntegrationId: undefined };
    })
    .filter(repo => repo !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  // Build the URL for creating a new repo
  // For orgs: https://github.com/organizations/{org}/repositories/new
  // For users: https://github.com/new
  const newRepoUrl =
    accountType === 'Organization' && targetAccountName
      ? `https://github.com/organizations/${targetAccountName}/repositories/new`
      : 'https://github.com/new';

  return {
    hasGitHubIntegration: true,
    targetAccountName,
    alreadyMigrated: false,
    suggestedRepoName,
    newRepoUrl,
    installationSettingsUrl,
    availableRepos,
    repositorySelection,
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

  // 1. Atomically claim this project for migration (prevents concurrent migrations)
  // Sets migrated_at as a claim — only one concurrent caller can win.
  // We also require git_repo_full_name IS NULL so that a crashed previous attempt
  // (migrated_at set but git_repo_full_name never written) doesn't permanently block retries.
  const [project] = await db
    .update(app_builder_projects)
    .set({ migrated_at: new Date().toISOString() })
    .where(
      and(eq(app_builder_projects.id, projectId), isNull(app_builder_projects.git_repo_full_name))
    )
    .returning();

  if (!project) {
    return { success: false, error: 'already_migrated' };
  }

  try {
    const integration =
      owner.type === 'org'
        ? await resolveOrganizationGitHubIntegrationForRepository({
            organizationId: owner.id,
            repositoryFullName: repoFullName,
            expectedPlatformIntegrationId: params.expectedPlatformIntegrationId,
          }).then(result => (result.success ? result.integration : null))
        : await getIntegrationForOwner(owner, PLATFORM.GITHUB, INTEGRATION_STATUS.ACTIVE);

    if (!integration || !integration.platform_installation_id) {
      throw new MigrationError(
        owner.type === 'org' ? 'github_integration_unavailable' : 'github_app_not_installed'
      );
    }

    // 3. Validate the target repo exists, is accessible, and is empty
    let repoDetails: {
      fullName: string;
      cloneUrl: string;
      htmlUrl: string;
      isEmpty: boolean;
      isPrivate: boolean;
    } | null;

    try {
      repoDetails = await getRepositoryDetails(
        integration.platform_installation_id,
        repoFullName,
        getGitHubAppType(integration)
      );
    } catch (error) {
      throw new MigrationError('internal_error', { cause: error });
    }

    if (!repoDetails) {
      throw new MigrationError('repo_not_found');
    }

    if (!repoDetails.isEmpty) {
      throw new MigrationError('repo_not_empty');
    }

    // 4. Migrate on the worker (push + preview switch + schedule repo deletion)
    try {
      const migrateResult = await appBuilderClient.migrateToGithub(projectId, {
        githubRepo: repoDetails.fullName,
        userId,
        orgId: owner.type === 'org' ? owner.id : undefined,
        expectedPlatformIntegrationId: owner.type === 'org' ? integration.id : undefined,
      });

      if (!migrateResult.success) {
        throw new MigrationError('push_failed', { cause: migrateResult });
      }
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('push_failed', { cause: error });
    }

    // 5. Update deployment if exists
    if (project.deployment_id) {
      await db
        .update(deployments)
        .set({
          source_type: 'github',
          repository_source: repoDetails.fullName,
          platform_integration_id: integration.id,
        })
        .where(eq(deployments.id, project.deployment_id));
    }

    // 6. Finalize project record (migrated_at already set by the atomic claim)
    await db
      .update(app_builder_projects)
      .set({
        git_repo_full_name: repoDetails.fullName,
        git_platform_integration_id: integration.id,
      })
      .where(eq(app_builder_projects.id, projectId));

    return {
      success: true,
      githubRepoUrl: repoDetails.htmlUrl,
      newSessionId: project.session_id ?? '',
    };
  } catch (error) {
    // Release the migration claim on any failure
    await db
      .update(app_builder_projects)
      .set({ migrated_at: null })
      .where(eq(app_builder_projects.id, projectId));

    if (error instanceof MigrationError) {
      if (error.cause) {
        console.error(`Migration failed (${error.code}):`, error.cause);
      }
      return { success: false, error: error.code };
    }
    throw error;
  }
}
