/**
 * Minimal GitHub App validation helpers for dev seeds.
 *
 * Replicates the two read-only calls the web app makes in
 * apps/web/src/lib/integrations/platforms/github/adapter.ts
 * (`fetchGitHubInstallationDetails` / `fetchGitHubRepositories`) so a seed can
 * confirm an installation exists and which repositories it can access before
 * writing a `platform_integrations` row. Seed topics must not import from
 * `apps/web/src`, so keep this file self-contained.
 *
 * Credentials come from the same env vars the web app uses
 * (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`, or the `GITHUB_LITE_APP_*` pair),
 * loaded via `apps/web/src/lib/load-env` through `lib/db.ts`. The private key
 * and the installation token minted below never leave this process: they are
 * not logged, returned, or persisted.
 */
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export type SeedGitHubAppType = 'standard' | 'lite';

export type SeedGitHubInstallationDetails = {
  accountId: number;
  accountLogin: string;
  repositorySelection: string;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
};

export type SeedGitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

function getSeedGitHubAppCredentials(appType: SeedGitHubAppType): {
  appId: string;
  privateKey: string;
} {
  const idVar = appType === 'lite' ? 'GITHUB_LITE_APP_ID' : 'GITHUB_APP_ID';
  const keyVar = appType === 'lite' ? 'GITHUB_LITE_APP_PRIVATE_KEY' : 'GITHUB_APP_PRIVATE_KEY';
  const appId = process.env[idVar] ?? '';
  const privateKey = process.env[keyVar] ?? '';

  if (!appId || !privateKey) {
    throw new Error(
      `${idVar} and ${keyVar} must both be set. Copy .env.local from the main worktree ` +
        `(or run scripts/worktree-prepare.sh) so dev seeds can validate installations with GitHub.`
    );
  }

  return { appId, privateKey };
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }
  const { status } = error;
  return typeof status === 'number' ? status : null;
}

/**
 * Fetches installation details using app-level auth.
 * Throws a clear error when the installation does not exist for the configured app.
 */
export async function fetchSeedGitHubInstallationDetails(
  installationId: string,
  appType: SeedGitHubAppType
): Promise<SeedGitHubInstallationDetails> {
  const { appId, privateKey } = getSeedGitHubAppCredentials(appType);
  const auth = createAppAuth({ appId, privateKey });
  const { token } = await auth({ type: 'app' });
  const octokit = new Octokit({ auth: token });

  let data;
  try {
    ({ data } = await octokit.apps.getInstallation({
      installation_id: Number.parseInt(installationId, 10),
    }));
  } catch (error) {
    if (getErrorStatus(error) === 404) {
      throw new Error(
        `GitHub installation ${installationId} was not found for the configured ${appType} app. ` +
          `Check --installation-id and make sure the installation belongs to the app from ${appType === 'lite' ? 'GITHUB_LITE_APP_ID' : 'GITHUB_APP_ID'}.`
      );
    }
    throw error;
  }

  const account = data.account ?? null;
  const accountId = account && typeof account.id === 'number' ? account.id : 0;
  const accountLogin =
    account && 'login' in account && typeof account.login === 'string' ? account.login : '';

  if (!accountId || !accountLogin) {
    throw new Error(
      `GitHub installation ${installationId} has no usable account identity; refusing to seed it.`
    );
  }

  return {
    accountId,
    accountLogin,
    repositorySelection: data.repository_selection ?? 'all',
    permissions: data.permissions ?? {},
    events: data.events ?? [],
    createdAt: data.created_at,
  };
}

/**
 * Lists non-archived repositories accessible to the installation.
 * Mints an installation access token in memory; the token is used only for
 * this call and is never logged or stored.
 */
export async function fetchSeedGitHubRepositories(
  installationId: string,
  appType: SeedGitHubAppType
): Promise<SeedGitHubRepository[]> {
  const { appId, privateKey } = getSeedGitHubAppCredentials(appType);
  const auth = createAppAuth({ appId, privateKey, installationId });
  const { token } = await auth({ type: 'installation' });
  const octokit = new Octokit({ auth: token });

  const repositories: SeedGitHubRepository[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const { data } = await octokit.apps.listReposAccessibleToInstallation({
      per_page: perPage,
      page,
    });

    repositories.push(
      ...data.repositories
        .filter(repo => !repo.archived)
        .map(repo => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
        }))
    );

    if (data.repositories.length < perPage) break;
    page++;
  }

  return repositories;
}
