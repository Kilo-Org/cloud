import auditRelayPolicy from '../../policy/audit-relay.yaml';
import bouncerWatchPolicy from '../../policy/bouncer-watch.yaml';
import ciKilocodeAppKeyPolicy from '../../policy/ci-kilocode-app-key.yaml';
import ciKilocodeCommunityPolicy from '../../policy/ci-kilocode-community.yaml';
import ciKilocodeNotifyPolicy from '../../policy/ci-kilocode-notify.yaml';
import ciKilocodeOpencodeWatchPolicy from '../../policy/ci-kilocode-opencode-watch.yaml';
import ciKilocodeReleaseJetbrainsPolicy from '../../policy/ci-kilocode-release-jetbrains.yaml';
import ciKilocodeReleasePolicy from '../../policy/ci-kilocode-release.yaml';
import ciKilocodeScanNotifyPolicy from '../../policy/ci-kilocode-scan-notify.yaml';
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
  'ci-kilocode-app-key.yaml': ciKilocodeAppKeyPolicy,
  'ci-kilocode-community.yaml': ciKilocodeCommunityPolicy,
  'ci-kilocode-notify.yaml': ciKilocodeNotifyPolicy,
  'ci-kilocode-opencode-watch.yaml': ciKilocodeOpencodeWatchPolicy,
  'ci-kilocode-release-jetbrains.yaml': ciKilocodeReleaseJetbrainsPolicy,
  'ci-kilocode-release.yaml': ciKilocodeReleasePolicy,
  'ci-kilocode-scan-notify.yaml': ciKilocodeScanNotifyPolicy,
  'notifications.yaml': notificationsPolicy,
  'o11y.yaml': o11yPolicy,
  'usage-ingest.yaml': usageIngestPolicy,
  'web.yaml': webPolicy,
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
