import 'server-only';
import { TRPCError } from '@trpc/server';
import type { CloudAgentPrWatch } from '@kilocode/db/schema';
import type { WatchPrMaintenancePolicy } from '@kilocode/db/cloud-agent-pr-maintenance';
import {
  authorizeMaintenanceExecution,
  validateMaintenanceSettings,
} from './watch-pr-maintenance-authorization';
import { maintenanceWorkspace } from './watch-pr-maintenance-client';
import { watchPrProjectionSchema } from './watch-pr-events';
import { parseRepoReference } from '@/lib/integrations/platforms/github/pr-link-identity';
import type { MaintenanceReason } from './watch-pr-maintenance-reasons';

export class MaintenanceReadinessError extends TRPCError {
  constructor(readonly maintenanceReason: MaintenanceReason) {
    super({ code: 'PRECONDITION_FAILED', message: maintenanceReason });
  }
}

export async function maintenanceExecutionReadiness(
  watch: CloudAgentPrWatch,
  policy: WatchPrMaintenancePolicy
) {
  const { worktree } = await authorizeMaintenanceExecution(watch);
  if (worktree.parent_worktree_id && !worktree.base_sha)
    throw new MaintenanceReadinessError('maintenance_parent_commit_unavailable');
  await validateMaintenanceSettings({
    userId: watch.kilo_user_id,
    organizationId: watch.organization_id,
    policy,
    repoUrl: watch.repo_url,
  });
  const workspace = await maintenanceWorkspace({
    userId: watch.kilo_user_id,
    organizationId: watch.organization_id ?? undefined,
    worktreeId: watch.worktree_id,
  });
  if (
    (workspace.repoUrl !== undefined &&
      parseRepoReference(workspace.repoUrl)?.url !== watch.repo_url) ||
    (workspace.headRef !== undefined && workspace.headRef !== watch.head_ref)
  )
    throw new MaintenanceReadinessError('maintenance_pr_identity_changed');
  if (workspace.profileId !== policy.profileId || workspace.environmentId !== policy.environmentId)
    throw new MaintenanceReadinessError('maintenance_workspace_settings_changed');
  const prPurpose = watchPrProjectionSchema.parse(watch.projection).purpose;
  const purpose = prPurpose?.title.trim() || workspace.purpose?.trim() || prPurpose?.body.trim();
  if (!purpose) throw new MaintenanceReadinessError('maintenance_purpose_unavailable');
  const chunks = (label: string, text: string) =>
    text.match(/[\s\S]{1,1900}/g)?.map(chunk => `${label}\n${chunk}`) ?? [];
  return {
    worktree,
    purpose,
    constraints: [
      ...workspace.constraints,
      ...(prPurpose?.body ? chunks('Pull request description:', prPurpose.body) : []),
      ...(workspace.purpose
        ? chunks('Original user task and constraints:', workspace.purpose)
        : []),
    ],
  };
}
