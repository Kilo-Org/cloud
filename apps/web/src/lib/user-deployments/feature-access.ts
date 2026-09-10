export const DEPLOY_FEATURE_FLAG = 'deploy-feature';
export const DEPLOY_FEATURE_QUERY_STALE_TIME_MS = 5 * 60_000;

export function shouldShowDeployFeature(options: {
  isDevelopment: boolean;
  isFlagEnabled: boolean | undefined;
  hasExistingDeployments: boolean | undefined;
}): boolean {
  return (
    options.isDevelopment ||
    options.isFlagEnabled === true ||
    options.hasExistingDeployments === true
  );
}
