import auditRelayPolicy from '../../policy/audit-relay.yaml';
import bouncerWatchPolicy from '../../policy/bouncer-watch.yaml';
import ciStsDeployProofProductionPolicy from '../../policy/ci-sts-deploy-proof-production.yaml';
import ciStsDeployProofStagingPolicy from '../../policy/ci-sts-deploy-proof-staging.yaml';
import notificationsPolicy from '../../policy/notifications.yaml';
import o11yPolicy from '../../policy/o11y.yaml';
import usageIngestPolicy from '../../policy/usage-ingest.yaml';
import webPolicy from '../../policy/web.yaml';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import { loadPolicies, type PolicyIndex } from './load';
import { POLICY_FILES, type PolicyFile } from './registry';
import type { Policy } from './schema';

const sources: Record<PolicyFile, string> = {
  'audit-relay.yaml': auditRelayPolicy,
  'bouncer-watch.yaml': bouncerWatchPolicy,
  'notifications.yaml': notificationsPolicy,
  'o11y.yaml': o11yPolicy,
  'usage-ingest.yaml': usageIngestPolicy,
  'web.yaml': webPolicy,
  'ci-sts-deploy-proof-staging.yaml': ciStsDeployProofStagingPolicy,
  'ci-sts-deploy-proof-production.yaml': ciStsDeployProofProductionPolicy,
};

/** Parsed and validated once per isolate; an invalid policy file fails every entry here. */
export const policyIndex: PolicyIndex = loadPolicies(sources);

export function policyFor(environment: StsEnvironment, workload: string): Policy | null {
  return policyIndex.get(environment, workload);
}

export function workloadPolicyHash(environment: StsEnvironment, workload: string): Promise<string> {
  return policyIndex.workloadHash(environment, workload);
}

export { POLICY_FILES };
