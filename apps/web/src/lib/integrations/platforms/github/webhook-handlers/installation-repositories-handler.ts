import { NextResponse } from 'next/server';
import { type PlatformRepository } from '@/lib/integrations/core/types';
import { updateGitHubInstallationRepositories } from '@/lib/integrations/db/github-installations';
import type { InstallationRepositoriesPayload } from '../webhook-schemas';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
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

  const repositoriesAdded: PlatformRepository[] =
    action === GITHUB_ACTION.ADDED
      ? (repositories_added ?? []).map(repo => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
        }))
      : [];
  const repositoryIdsRemoved =
    action === GITHUB_ACTION.REMOVED ? (repositories_removed ?? []).map(repo => repo.id) : [];
  await updateGitHubInstallationRepositories({
    installationId: installation.id.toString(),
    appType,
    repositoriesAdded,
    repositoryIdsRemoved,
  });

  logExceptInTest('Installation repositories updated:', {
    installation_id: installation.id,
    action,
    added_repos: repositoriesAdded.length,
  });

  return NextResponse.json({ message: 'Repositories updated' }, { status: 200 });
}
