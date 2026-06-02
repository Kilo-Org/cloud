import { safeLocalStorage } from '@/lib/localStorage';
import type { RepositoryPlatform } from '@/components/shared/RepositoryCombobox';

export const GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY =
  'cloud-agent:github-identity-hint-dismissed';

type GitHubUserAuthorization = {
  connected: boolean;
  githubLogin: string | null;
  revoked: boolean;
};

type GitHubIdentityHintOptions = {
  selectedRepo: string;
  selectedPlatform: RepositoryPlatform;
  authorization: GitHubUserAuthorization | undefined;
  isLoading: boolean;
  isError: boolean;
  isDismissed: boolean;
};

export type GitHubIdentityHint = {
  body: string;
  linkLabel: string;
  href: string;
};

type GitHubIdentityHintStorage = Pick<typeof safeLocalStorage, 'getItem' | 'setItem'>;

const githubIdentityHint: GitHubIdentityHint = {
  body: 'Commit as yourself instead of the Kilo bot.',
  linkLabel: 'Set up identity',
  href: '/integrations/github#github-identity',
};

export function parseGitHubIdentityHintDismissed(storedValue: string | null) {
  return storedValue === 'true';
}

export function getGitHubIdentityHintDismissed(
  storage: GitHubIdentityHintStorage = safeLocalStorage
) {
  return parseGitHubIdentityHintDismissed(
    storage.getItem(GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY)
  );
}

export function markGitHubIdentityHintDismissed(
  storage: GitHubIdentityHintStorage = safeLocalStorage
) {
  storage.setItem(GITHUB_IDENTITY_HINT_DISMISSED_STORAGE_KEY, 'true');
}

export function getGitHubIdentityHint({
  selectedRepo,
  selectedPlatform,
  authorization,
  isLoading,
  isError,
  isDismissed,
}: GitHubIdentityHintOptions): GitHubIdentityHint | null {
  if (
    !selectedRepo ||
    selectedPlatform !== 'github' ||
    !authorization ||
    isLoading ||
    isError ||
    isDismissed ||
    authorization.connected ||
    authorization.revoked
  ) {
    return null;
  }
  return githubIdentityHint;
}
