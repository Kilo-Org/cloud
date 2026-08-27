import type { GitHubMigrationTarget } from '@/lib/app-builder/types';

export function resolveMigrationTarget(
  targets: GitHubMigrationTarget[],
  pinnedTarget?: GitHubMigrationTarget
): { target: GitHubMigrationTarget | undefined; isUnavailable: boolean } {
  if (!pinnedTarget) {
    return { target: targets[0], isUnavailable: false };
  }

  const currentTarget = targets.find(
    target => target.platformIntegrationId === pinnedTarget.platformIntegrationId
  );
  return {
    target: currentTarget ?? pinnedTarget,
    isUnavailable: currentTarget === undefined,
  };
}

export function getMigrationTargetLabel(
  target: GitHubMigrationTarget,
  targets: GitHubMigrationTarget[]
): string {
  const duplicateAccount = targets.some(
    candidate =>
      candidate.platformIntegrationId !== target.platformIntegrationId &&
      candidate.platformAccountLogin.toLowerCase() === target.platformAccountLogin.toLowerCase()
  );
  if (!duplicateAccount) return target.platformAccountLogin;

  return `${target.platformAccountLogin} (${target.githubAppType === 'lite' ? 'Lite app' : 'Standard app'})`;
}
