import 'server-only';

import { Octokit } from '@octokit/rest';
import { eq } from 'drizzle-orm';
import { cloud_agent_pr_watches, type CloudAgentPrWatch } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import {
  claimPrMaintenanceCall,
  PrMaintenanceDeferredError,
} from '@/lib/integrations/platforms/github/pr-refresh-budget';

export async function watchPrGitHubClient(watch: CloudAgentPrWatch): Promise<Octokit> {
  const signal = AbortSignal.timeout(15_000);
  const token = await generateGitHubInstallationToken(
    watch.installation_id,
    watch.github_app_type,
    watch.integration_id,
    'agent',
    signal
  );
  return new Octokit({ auth: token.token, request: { signal } });
}

export async function assertWatchPrGitHubCall(watch: CloudAgentPrWatch) {
  const budget = await claimPrMaintenanceCall({
    appType: watch.github_app_type,
    installationId: watch.installation_id,
  });
  if (!budget.allowed) throw new PrMaintenanceDeferredError(budget.reason, budget.retryAt);
  const [current] = await db
    .select({
      status: cloud_agent_pr_watches.status,
      generation: cloud_agent_pr_watches.generation,
      headSha: cloud_agent_pr_watches.head_sha,
      pendingRevision: cloud_agent_pr_watches.pending_revision,
    })
    .from(cloud_agent_pr_watches)
    .where(eq(cloud_agent_pr_watches.id, watch.id))
    .limit(1);
  if (
    !current ||
    current.status !== 'watching' ||
    current.generation !== watch.generation ||
    current.headSha !== watch.head_sha
  )
    throw new Error('PR maintenance authorization or head changed');
  return current;
}
