import aiGatewaySecureProxyPolicy from '../../policy/ai-gateway-secure-proxy.yaml';
import aiGatewayPolicy from '../../policy/ai-gateway.yaml';
import auditRelayPolicy from '../../policy/audit-relay.yaml';
import autoRoutingBenchmarkPolicy from '../../policy/auto-routing-benchmark.yaml';
import autoRoutingPolicy from '../../policy/auto-routing.yaml';
import bouncerWatchPolicy from '../../policy/bouncer-watch.yaml';
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
