import 'server-only';
import type { Owner } from '@/lib/integrations/core/types';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { db } from '@/lib/drizzle';
import { app_builder_projects, platform_integrations, deployments } from '@/db/schema';
import { TRPCError } from '@trpc/server';
import { eq, and, isNull } from 'drizzle-orm';
import {
  fetchGitHubInstallationDetails,
  generateGitHubInstallationToken,
  getRepositoryDetails,
  getInstallationSettingsUrl,
  fetchGitHubRepositoriesWithDates,
} from '@/lib/integrations/platforms/github/adapter';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/app-builder-service';
import type {
  MigrateToGitHubInput,
  MigrateToGitHubResult,
  CanMigrateToGitHubResult,
} from '@/lib/app-builder/types';

/**
 * Sanitize a string for use as a GitHub repository name.
 * GitHub repo names can only contain alphanumeric characters, hyphens, underscores, and periods.
 */
function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-') // Replace invalid chars with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^[-.]|[-.]$/g, '') // Remove leading/trailing hyphens and dots
    .substring(0, 100); // Truncate to 100 chars
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
  const suggestedRepoName = sanitizeRepoName(project.title);

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

  // Check for GitHub integration
  const ownerCondition =
    owner.type === 'org'
      ? eq(platform_integrations.owned_by_organization_id, owner.id)
      : eq(platform_integrations.owned_by_user_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownerCondition,
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration || !integration.platform_installation_id) {
    return noIntegrationResult;
  }

  // Fetch installation details and available repos in parallel
  const installationId = integration.platform_installation_id;
  let targetAccountName = integration.platform_account_login ?? null;
  let installationSettingsUrl = '';
  let availableRepos: CanMigrateToGitHubResult['availableRepos'] = [];
  let accountType = 'User';
  let repositorySelection: 'all' | 'selected' = 'all';

  try {
    const [installationDetails, settingsUrl, repos] = await Promise.all([
      fetchGitHubInstallationDetails(installationId),
      getInstallationSettingsUrl(installationId),
      fetchGitHubRepositoriesWithDates(installationId),
    ]);

    targetAccountName = installationDetails.account.login || targetAccountName;
    accountType = installationDetails.account.type;
    repositorySelection =
      installationDetails.repository_selection === 'selected' ? 'selected' : 'all';
    installationSettingsUrl = settingsUrl;
    availableRepos = repos;
  } catch (error) {
    console.error('Failed to fetch GitHub installation details:', error);
    // Continue with partial data
  }

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

  // 1. Atomically claim this project for migration (prevents concurrent migrations)
  // Sets migrated_at as a claim — only one concurrent caller can win.
  // We also require git_repo_full_name IS NULL so that a crashed previous attempt
  // (migrated_at set but git_repo_full_name never written) doesn't permanently block retries.
  const projectOwnerCondition =
    owner.type === 'org'
      ? eq(app_builder_projects.owned_by_organization_id, owner.id)
      : eq(app_builder_projects.owned_by_user_id, owner.id);

  const [project] = await db
    .update(app_builder_projects)
    .set({ migrated_at: new Date().toISOString() })
    .where(
      and(
        eq(app_builder_projects.id, projectId),
        projectOwnerCondition,
        isNull(app_builder_projects.git_repo_full_name)
      )
    )
    .returning();

  if (!project) {
    // Either project not found, wrong owner, or already migrated
    const [existing] = await db
      .select()
      .from(app_builder_projects)
      .where(and(eq(app_builder_projects.id, projectId), projectOwnerCondition));
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' });
    }
    return { success: false, error: 'already_migrated' };
  }

  // Release the migration claim on failure
  async function releaseMigrationClaim() {
    await db
      .update(app_builder_projects)
      .set({ migrated_at: null })
      .where(eq(app_builder_projects.id, projectId));
  }

  // 2. Get GitHub integration for the owner
  const integrationOwnerCondition =
    owner.type === 'org'
      ? eq(platform_integrations.owned_by_organization_id, owner.id)
      : eq(platform_integrations.owned_by_user_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        integrationOwnerCondition,
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration || !integration.platform_installation_id) {
    await releaseMigrationClaim();
    return { success: false, error: 'github_app_not_installed' };
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
    repoDetails = await getRepositoryDetails(integration.platform_installation_id, repoFullName);
  } catch (error) {
    console.error('Failed to get repository details:', error);
    await releaseMigrationClaim();
    return { success: false, error: 'internal_error' };
  }

  if (!repoDetails) {
    // Repo doesn't exist or not accessible to the GitHub App
    await releaseMigrationClaim();
    return { success: false, error: 'repo_not_found' };
  }

  if (!repoDetails.isEmpty) {
    // Repo has commits - must be empty for migration
    await releaseMigrationClaim();
    return { success: false, error: 'repo_not_empty' };
  }

  // 4. Generate GitHub token and migrate on the worker (push + preview switch + schedule repo deletion)
  try {
    const tokenData = await generateGitHubInstallationToken(integration.platform_installation_id);

    const migrateResult = await appBuilderClient.migrateToGithub(projectId, {
      remoteUrl: repoDetails.cloneUrl,
      remoteAuthToken: tokenData.token,
      githubRepo: repoDetails.fullName,
      userId,
      orgId: owner.type === 'org' ? owner.id : undefined,
    });

    if (!migrateResult.success) {
      console.error('Migration on worker failed:', migrateResult);
      await releaseMigrationClaim();
      return { success: false, error: 'push_failed' };
    }
  } catch (error) {
    console.error('Migration error:', error);
    await releaseMigrationClaim();
    return { success: false, error: 'push_failed' };
  }

  // 5. Update deployment if exists
  if (project.deployment_id) {
    try {
      await db
        .update(deployments)
        .set({
          source_type: 'github',
          repository_source: repoDetails.fullName,
          platform_integration_id: integration.id,
        })
        .where(eq(deployments.id, project.deployment_id));
    } catch (error) {
      // Log error but continue with migration - deployment update is not critical
      console.error('Failed to update deployment, continuing with migration:', error);
    }
  }

  // 6. Finalize project record (migrated_at already set by the atomic claim)
  try {
    await db
      .update(app_builder_projects)
      .set({
        git_repo_full_name: repoDetails.fullName,
        git_platform_integration_id: integration.id,
      })
      .where(eq(app_builder_projects.id, projectId));
  } catch (error) {
    console.error('Failed to update project record:', error);
    await releaseMigrationClaim();
    return { success: false, error: 'internal_error' };
  }

  return {
    success: true,
    githubRepoUrl: repoDetails.htmlUrl,
    newSessionId: project.session_id ?? '',
  };
}
