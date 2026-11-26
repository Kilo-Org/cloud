import auditRelayPolicy from '../../policy/audit-relay.yaml';
import o11yPolicy from '../../policy/o11y.yaml';
import usageIngestPolicy from '../../policy/usage-ingest.yaml';
import webPolicy from '../../policy/web.yaml';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import { loadPolicies, type PolicyIndex } from './load';
import { POLICY_FILES, type PolicyFile } from './registry';
import type { Policy } from './schema';

const sources: Record<PolicyFile, string> = {
  'audit-relay.yaml': auditRelayPolicy,
  'o11y.yaml': o11yPolicy,
  'usage-ingest.yaml': usageIngestPolicy,
  'web.yaml': webPolicy,
};

/** Parsed and validated once per isolate; an invalid policy file fails every entry here. */
export const policyIndex: PolicyIndex = loadPolicies(sources);

export function policyFor(environment: StsEnvironment, workload: string): Policy | null {
  return policyIndex.get(environment, workload);
}

export function policyExists(workload: string): boolean {
  return policyIndex.has(workload);
}

export function workloadPolicyHash(workload: string): Promise<string> {
  return policyIndex.workloadHash(workload);
}

export { POLICY_FILES };
