/**
 * Every workflow file in Kilo-Org/cloud's `.github/workflows`. `ci-cloud-policies.test.ts` presents
 * a token of each one to every cloud CI policy. `scripts/sts-bundle-callers.test.mjs`, which runs on
 * every change to `.github/workflows` and to this file, holds this list to the directory, so a PR
 * that adds or removes a workflow file must update it.
 */
export const CLOUD_WORKFLOW_FILES = [
  'auto-docs.yml',
  'check-deployment-changes.yml',
  'check-md-table-padding.yml',
  'chromatic.yml',
  'ci.yml',
  'cloud-agent-e2e.yml',
  'cloud-agent-runtime-publish.yml',
  'cloud-agent-sentry-sourcemaps.yml',
  'codeql.yml',
  'deploy-ai-gateway-secure-proxy.yml',
  'deploy-production.yml',
  'deploy-staging.yml',
  'deploy-workers.yml',
  'explorer-ios-release.yml',
  'extension-ci.yml',
  'extension-store-release.yml',
  'install-vercel-cli.yml',
  'kilo-app-changelog-history.yml',
  'kilo-app-ci.yml',
  'kilo-app-release.yml',
  'kilo-mcp-catalog.yml',
  'kilo-mcp-release.yml',
  'meta-janitor-approve.yml',
  'mobile-native-build.yml',
  'notify-main-failure.yml',
  'notify-production-deploy-failure.yml',
  'promote-vercel-deployment.yml',
  'push-dev-kiloclaw.yml',
  'redeploy-web.yml',
  'sbom.yml',
  'setup-smoke.yml',
  'stage-vercel-deployment.yml',
  'stale-prs.yaml',
  'sts-deployment-watch-health.yml',
  'sts-deployment-watch.yml',
  'trufflehog.yml',
] as const;
