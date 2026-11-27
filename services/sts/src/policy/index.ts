import aiGatewaySecureProxyPolicy from '../../policy/ai-gateway-secure-proxy.yaml';
import aiGatewayPolicy from '../../policy/ai-gateway.yaml';
import auditRelayPolicy from '../../policy/audit-relay.yaml';
import autoRoutingBenchmarkPolicy from '../../policy/auto-routing-benchmark.yaml';
import autoRoutingPolicy from '../../policy/auto-routing.yaml';
import bouncerWatchPolicy from '../../policy/bouncer-watch.yaml';
import ciDbMigrateStagingPolicy from '../../policy/ci-db-migrate-staging.yaml';
import ciDbMigratePolicy from '../../policy/ci-db-migrate.yaml';
import ciDeployBouncerPolicy from '../../policy/ci-deploy-bouncer.yaml';
import ciDeployCloudMcpCatalogPolicy from '../../policy/ci-deploy-cloud-mcp-catalog.yaml';
import ciDeployCloudRuntimePolicy from '../../policy/ci-deploy-cloud-runtime.yaml';
import ciDeployCloudStagingPolicy from '../../policy/ci-deploy-cloud-staging.yaml';
import ciDeployCloudPolicy from '../../policy/ci-deploy-cloud.yaml';
import ciKilocodeAppKeyPolicy from '../../policy/ci-kilocode-app-key.yaml';
import ciKilocodeCommunityPolicy from '../../policy/ci-kilocode-community.yaml';
import ciKilocodeNotifyPolicy from '../../policy/ci-kilocode-notify.yaml';
import ciKilocodeOpencodeWatchPolicy from '../../policy/ci-kilocode-opencode-watch.yaml';
import ciKilocodeReleaseJetbrainsPolicy from '../../policy/ci-kilocode-release-jetbrains.yaml';
import ciKilocodeReleasePolicy from '../../policy/ci-kilocode-release.yaml';
import ciKilocodeScanNotifyPolicy from '../../policy/ci-kilocode-scan-notify.yaml';
import cloudAgentNextPolicy from '../../policy/cloud-agent-next.yaml';
import cloudflareGmailPushPolicy from '../../policy/cloudflare-gmail-push.yaml';
import cloudflareScimSyncPolicy from '../../policy/cloudflare-scim-sync.yaml';
import cloudflareSecuritySyncPolicy from '../../policy/cloudflare-security-sync.yaml';
import cloudflareWebhookAgentIngestPolicy from '../../policy/cloudflare-webhook-agent-ingest.yaml';
import containerUsageMeterPolicy from '../../policy/container-usage-meter.yaml';
import eventServicePolicy from '../../policy/event-service.yaml';
import gitTokenServicePolicy from '../../policy/git-token-service.yaml';
import kiloAiAttributionPolicy from '../../policy/kilo-ai-attribution.yaml';
import kiloChatPolicy from '../../policy/kilo-chat.yaml';
import kiloCodeReviewWorkerPolicy from '../../policy/kilo-code-review-worker.yaml';
import kiloMcpPolicy from '../../policy/kilo-mcp.yaml';
import kiloOpsPolicy from '../../policy/kilo-ops.yaml';
import kiloclawBillingPolicy from '../../policy/kiloclaw-billing.yaml';
import kiloclawInboundEmailPolicy from '../../policy/kiloclaw-inbound-email.yaml';
import kiloclawPolicy from '../../policy/kiloclaw.yaml';
import migrationProxyPolicy from '../../policy/migration-proxy.yaml';
import modelEvalIngestPolicy from '../../policy/model-eval-ingest.yaml';
import notificationsPolicy from '../../policy/notifications.yaml';
import o11yPolicy from '../../policy/o11y.yaml';
import pagesDevPolicy from '../../policy/pages-dev.yaml';
import securityAutoAnalysisPolicy from '../../policy/security-auto-analysis.yaml';
import sessionIngestPolicy from '../../policy/session-ingest.yaml';
import sessionSyncPolicy from '../../policy/session-sync.yaml';
import usageIngestPolicy from '../../policy/usage-ingest.yaml';
import userDataExportPolicy from '../../policy/user-data-export.yaml';
import webPolicy from '../../policy/web.yaml';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import { loadPolicies, type PolicyIndex } from './load';
import { POLICY_FILES, type PolicyFile } from './registry';
import type { Policy } from './schema';

const sources: Record<PolicyFile, string> = {
  'ai-gateway.yaml': aiGatewayPolicy,
  'ai-gateway-secure-proxy.yaml': aiGatewaySecureProxyPolicy,
  'audit-relay.yaml': auditRelayPolicy,
  'auto-routing.yaml': autoRoutingPolicy,
  'auto-routing-benchmark.yaml': autoRoutingBenchmarkPolicy,
  'bouncer-watch.yaml': bouncerWatchPolicy,
  'ci-db-migrate.yaml': ciDbMigratePolicy,
  'ci-db-migrate-staging.yaml': ciDbMigrateStagingPolicy,
  'ci-deploy-bouncer.yaml': ciDeployBouncerPolicy,
  'ci-deploy-cloud.yaml': ciDeployCloudPolicy,
  'ci-deploy-cloud-staging.yaml': ciDeployCloudStagingPolicy,
  'ci-deploy-cloud-runtime.yaml': ciDeployCloudRuntimePolicy,
  'ci-deploy-cloud-mcp-catalog.yaml': ciDeployCloudMcpCatalogPolicy,
  'ci-kilocode-app-key.yaml': ciKilocodeAppKeyPolicy,
  'ci-kilocode-community.yaml': ciKilocodeCommunityPolicy,
  'ci-kilocode-notify.yaml': ciKilocodeNotifyPolicy,
  'ci-kilocode-opencode-watch.yaml': ciKilocodeOpencodeWatchPolicy,
  'ci-kilocode-release-jetbrains.yaml': ciKilocodeReleaseJetbrainsPolicy,
  'ci-kilocode-release.yaml': ciKilocodeReleasePolicy,
  'ci-kilocode-scan-notify.yaml': ciKilocodeScanNotifyPolicy,
  'cloud-agent-next.yaml': cloudAgentNextPolicy,
  'cloudflare-gmail-push.yaml': cloudflareGmailPushPolicy,
  'cloudflare-scim-sync.yaml': cloudflareScimSyncPolicy,
  'cloudflare-security-sync.yaml': cloudflareSecuritySyncPolicy,
  'cloudflare-webhook-agent-ingest.yaml': cloudflareWebhookAgentIngestPolicy,
  'container-usage-meter.yaml': containerUsageMeterPolicy,
  'event-service.yaml': eventServicePolicy,
  'git-token-service.yaml': gitTokenServicePolicy,
  'kilo-ai-attribution.yaml': kiloAiAttributionPolicy,
  'kilo-chat.yaml': kiloChatPolicy,
  'kilo-code-review-worker.yaml': kiloCodeReviewWorkerPolicy,
  'kilo-mcp.yaml': kiloMcpPolicy,
  'kilo-ops.yaml': kiloOpsPolicy,
  'kiloclaw.yaml': kiloclawPolicy,
  'kiloclaw-billing.yaml': kiloclawBillingPolicy,
  'kiloclaw-inbound-email.yaml': kiloclawInboundEmailPolicy,
  'migration-proxy.yaml': migrationProxyPolicy,
  'model-eval-ingest.yaml': modelEvalIngestPolicy,
  'notifications.yaml': notificationsPolicy,
  'o11y.yaml': o11yPolicy,
  'pages-dev.yaml': pagesDevPolicy,
  'security-auto-analysis.yaml': securityAutoAnalysisPolicy,
  'session-ingest.yaml': sessionIngestPolicy,
  'session-sync.yaml': sessionSyncPolicy,
  'usage-ingest.yaml': usageIngestPolicy,
  'user-data-export.yaml': userDataExportPolicy,
  'web.yaml': webPolicy,
};

/**
 * Parsed and validated once per isolate; an invalid policy or registration file fails every entry
 * here. A registration adds nothing STS serves (see `PolicyIndex`).
 */
export const policyIndex: PolicyIndex = loadPolicies(sources);

export function policyFor(environment: StsEnvironment, workload: string): Policy | null {
  return policyIndex.get(environment, workload);
}

export function workloadPolicyHash(environment: StsEnvironment, workload: string): Promise<string> {
  return policyIndex.workloadHash(environment, workload);
}

export { POLICY_FILES };
