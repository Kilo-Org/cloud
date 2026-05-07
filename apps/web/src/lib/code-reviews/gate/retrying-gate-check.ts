import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { CloudAgentCodeReview, PlatformIntegration } from '@kilocode/db/schema';
import { updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { setCommitStatus } from '@/lib/integrations/platforms/gitlab/adapter';
import {
  getStoredProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';

type RetryGateReview = Pick<
  CloudAgentCodeReview,
  | 'id'
  | 'platform'
  | 'platform_project_id'
  | 'pr_number'
  | 'repo_full_name'
  | 'head_sha'
  | 'check_run_id'
>;

function getGitLabInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  return metadata?.gitlab_instance_url || 'https://gitlab.com';
}

async function resolveGitLabAccessToken(
  integration: PlatformIntegration,
  projectId: number | null
): Promise<string> {
  const storedPrat = projectId ? getStoredProjectAccessToken(integration, projectId) : null;
  return storedPrat ? storedPrat.token : await getValidGitLabToken(integration);
}

export async function updateCodeReviewRetryingGateCheck(
  review: RetryGateReview,
  integration: PlatformIntegration
): Promise<void> {
  const platform = review.platform || 'github';
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  if (platform === 'github' && integration.platform_installation_id && review.check_run_id) {
    const appType = integration.github_app_type ?? 'standard';
    if (appType === 'lite') return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');
    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status: 'in_progress',
        detailsUrl,
        output: {
          title: 'Kilo Code Review retrying',
          summary: 'The previous sandbox became unhealthy. Retrying once in a fresh attempt.',
        },
      },
      appType
    );
    return;
  }

  if (platform === PLATFORM.GITLAB) {
    const accessToken = await resolveGitLabAccessToken(integration, review.platform_project_id);
    await setCommitStatus(
      accessToken,
      review.platform_project_id ?? review.repo_full_name,
      review.head_sha,
      'running',
      {
        targetUrl: detailsUrl,
        description: 'Kilo Code Review retrying after sandbox recovery',
      },
      getGitLabInstanceUrl(integration)
    );
  }
}
