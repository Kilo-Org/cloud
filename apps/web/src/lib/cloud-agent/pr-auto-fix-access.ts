import 'server-only';
import { TRPCError } from '@trpc/server';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

export async function canUsePullRequestAutoFix(userId: string): Promise<boolean> {
  if (process.env.NODE_ENV === 'development') {
    return process.env.CLOUD_AGENT_PR_AUTO_FIX_DEV_USER_ID === userId;
  }
  return isReleaseToggleEnabled('cloud-agent-pr-auto-fix', userId);
}

export class PullRequestAutoFixUnavailableError extends TRPCError {
  readonly maintenanceReason = 'maintenance_feature_unavailable';

  constructor() {
    super({
      code: 'FORBIDDEN',
      message: 'Pull request auto-fix is not available for this account.',
    });
  }
}

export async function requirePullRequestAutoFix(userId: string): Promise<void> {
  if (!(await canUsePullRequestAutoFix(userId))) throw new PullRequestAutoFixUnavailableError();
}
