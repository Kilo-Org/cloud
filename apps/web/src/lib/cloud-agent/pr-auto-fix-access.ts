import 'server-only';
import { TRPCError } from '@trpc/server';

export function getPullRequestAutoFixUserId(): string | null {
  return process.env.CLOUD_AGENT_PR_AUTO_FIX_USER_ID?.trim() || null;
}

export function canUsePullRequestAutoFix(userId: string): boolean {
  return getPullRequestAutoFixUserId() === userId;
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

export function requirePullRequestAutoFix(userId: string): void {
  if (!canUsePullRequestAutoFix(userId)) throw new PullRequestAutoFixUnavailableError();
}
