import auditRelayPolicy from '../../policy/audit-relay.yaml';
import bouncerWatchPolicy from '../../policy/bouncer-watch.yaml';
import o11yPolicy from '../../policy/o11y.yaml';
import usageIngestPolicy from '../../policy/usage-ingest.yaml';
import webPolicy from '../../policy/web.yaml';
import type { StsEnvironment } from '@kilocode/sts-contracts';
import { loadPolicies, type PolicyIndex, type PolicySnapshotEntry } from './load';
import { POLICY_FILES, type PolicyFile } from './registry';
import type { Policy } from './schema';

const sources: Record<PolicyFile, string> = {
  'audit-relay.yaml': auditRelayPolicy,
  'bouncer-watch.yaml': bouncerWatchPolicy,
  'o11y.yaml': o11yPolicy,
  'usage-ingest.yaml': usageIngestPolicy,
  'web.yaml': webPolicy,
};

/** Parsed and validated once per isolate; an invalid policy file fails every entry here. */
export const policyIndex: PolicyIndex = loadPolicies(sources);

export function policiesFor(environment: StsEnvironment): Policy[] {
  return policyIndex.forEnvironment(environment);
}

export function policyFor(environment: StsEnvironment, workload: string): Policy | null {
  return policyIndex.get(environment, workload);
}

export function policyExists(workload: string): boolean {
  return policyIndex.has(workload);
}

export function policySnapshot(): PolicySnapshotEntry[] {
  return policyIndex.snapshot();
}

export function currentPolicyHash(): Promise<string> {
  return policyIndex.hash();
}

export function workloadPolicyHash(workload: string): Promise<string> {
  return policyIndex.workloadHash(workload);
}

export { POLICY_FILES };
