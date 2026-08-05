import { NextResponse } from 'next/server';
import {
  requireNumericPlatformRepositories,
  type PlatformRepository,
} from '@/lib/integrations/core/types';
import {
  findIntegrationByInstallationId,
  updateIntegrationRepositories,
} from '@/lib/integrations/db/platform-integrations';
import type { InstallationRepositoriesPayload } from '../webhook-schemas';
import { PLATFORM, GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import type { GitHubAppType } from '../app-selector';

/**
 * GitHub Installation Repositories Event Handler
 * Handles: repositories added/removed
 */

export async function handleInstallationRepositories(
  payload: InstallationRepositoriesPayload,
  appType: GitHubAppType
) {
  const { installation, action, repositories_added, repositories_removed } = payload;

  const integration = await findIntegrationByInstallationId(
    PLATFORM.GITHUB,
    installation.id.toString(),
    appType
  );

  if (!integration) {
    console.warn('Installation not found:', installation.id);
    return NextResponse.json({ message: 'Integration not found' }, { status: 404 });
  }

  // Get current repositories
  const currentRepos = requireNumericPlatformRepositories(integration.repositories) ?? [];
  let updatedRepos: PlatformRepository[] = currentRepos;

  if (action === GITHUB_ACTION.ADDED && repositories_added) {
    const addedRepos: PlatformRepository[] = repositories_added.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
    }));
    updatedRepos = [...currentRepos, ...addedRepos];
  } else if (action === GITHUB_ACTION.REMOVED && repositories_removed) {
    const removedIds = repositories_removed.map(repo => repo.id);
    updatedRepos = currentRepos.filter((repo: PlatformRepository) => !removedIds.includes(repo.id));
  }

  await updateIntegrationRepositories(
    PLATFORM.GITHUB,
    installation.id.toString(),
    updatedRepos,
    appType
  );

  logExceptInTest('Installation repositories updated:', {
    installation_id: installation.id,
    action,
    total_repos: updatedRepos.length,
  });

  return NextResponse.json({ message: 'Repositories updated' }, { status: 200 });
}
