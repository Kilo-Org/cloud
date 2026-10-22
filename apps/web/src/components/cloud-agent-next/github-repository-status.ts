export type GitHubRepositoryUnavailableReason =
  | 'suspended'
  | 'disconnected'
  | 'reauth_required'
  | 'pending_approval'
  | 'not_configured';

type GitHubRepositoryListState = {
  integrationInstalled: boolean;
  errorMessage?: string;
  unavailableReason?: GitHubRepositoryUnavailableReason;
  partial?: boolean;
};

export type GitHubRepositoryNotice =
  | {
      kind: 'reconnect';
      message: string;
      settingsHref: string;
    }
  | {
      kind: 'partial';
      message: string;
    };

const FALLBACK_RECONNECT_MESSAGE = 'GitHub integration needs to be reconnected';
const PARTIAL_MESSAGE = 'Some GitHub installations could not be loaded. Refresh to try again.';

/**
 * Where an organization or personal GitHub connection is repaired. The reason
 * states need an admin action there, so the picker links to the same settings
 * page the onboarding panel uses instead of a bare refresh.
 */
export function githubIntegrationSettingsHref(organizationId?: string): string {
  return organizationId
    ? `/organizations/${organizationId}/integrations/github`
    : '/integrations/github';
}

/**
 * What a repository picker must say about a GitHub list that is not complete.
 *  - `reconnect`: an installation exists but none can list repositories, so the
 *    reason (already carried by the server message) names the fix.
 *  - `partial`: some installations answered, so the rows on screen are a subset.
 */
export function getGitHubRepositoryNotices(
  state: GitHubRepositoryListState | undefined,
  settingsHref: string
): GitHubRepositoryNotice[] {
  if (!state) return [];
  const notices: GitHubRepositoryNotice[] = [];
  if (!state.integrationInstalled && state.unavailableReason) {
    notices.push({
      kind: 'reconnect',
      message: state.errorMessage ?? FALLBACK_RECONNECT_MESSAGE,
      settingsHref,
    });
  }
  if (state.partial) {
    notices.push({ kind: 'partial', message: PARTIAL_MESSAGE });
  }
  return notices;
}
