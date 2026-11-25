import type { StsEnvironment } from '@kilocode/sts-contracts';
import { parse } from 'yaml';
import { sha256Base64Url } from '../crypto/hash';
import { PolicySchema, policyFileProblems, type Policy } from './schema';

export type PolicySnapshotEntry = {
  workload: string;
  environments: string[];
  identity: string;
  secrets: string[];
};

export type PolicyIndex = {
  all(): Policy[];
  forEnvironment(environment: StsEnvironment): Policy[];
  has(workload: string): boolean;
  get(environment: StsEnvironment, workload: string): Policy | null;
  snapshot(): PolicySnapshotEntry[];
  hash(): Promise<string>;
  /** Hash of one workload's secret grants; a bundle built under another hash is out of date. */
  workloadHash(workload: string): Promise<string>;
};

function sortedList(values: readonly string[] | undefined): string {
  return [...(values ?? [])].sort().join(',');
}

function canonicalIdentity(policy: Policy): string {
  const identity = policy.identity;
  switch (identity.kind) {
    case 'worker-binding':
      return 'worker-binding';
    case 'fly-oidc':
      return `fly-oidc|${identity.org}|${identity.orgId}|${identity.app}|${identity.appId}`;
    case 'github-oidc':
      return `github-oidc|${identity.repositoryId}|${identity.repositoryOwnerId}|${sortedList(identity.environments)}|${sortedList(identity.refs)}|${sortedList(identity.allowedEvents)}`;
  }
}

function bindingKey(policy: Policy): string | null {
  const identity = policy.identity;
  switch (identity.kind) {
    case 'worker-binding':
      return null;
    case 'fly-oidc':
      return `fly-oidc|${identity.orgId}|${identity.appId}`;
    case 'github-oidc':
      return `github-oidc|${identity.repositoryOwnerId}|${identity.repositoryId}`;
  }
}

export function loadPolicies(sources: Record<string, string>): PolicyIndex {
  const policies: Policy[] = [];
  for (const [file, source] of Object.entries(sources)) {
    let document: unknown;
    try {
      document = parse(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown parse error';
      throw new Error(`${file} is not valid YAML: ${detail}`);
    }
    const parsed = PolicySchema.safeParse(document);
    if (!parsed.success) {
      throw new Error(`${file} does not match the policy schema: ${parsed.error.message}`);
    }
    const policy = parsed.data;
    const problems = policyFileProblems(policy);
    if (problems.length > 0) {
      throw new Error(`${file} is invalid: ${problems.join('; ')}`);
    }
    if (file !== `${policy.workload}.yaml`) {
      throw new Error(`${file} must be named ${policy.workload}.yaml after its workload`);
    }
    policies.push(policy);
  }
  policies.sort((left, right) => left.workload.localeCompare(right.workload));

  const workloads = new Set<string>();
  const bindings = new Map<string, string>();
  for (const policy of policies) {
    if (workloads.has(policy.workload)) {
      throw new Error(`more than one policy file declares workload ${policy.workload}`);
    }
    workloads.add(policy.workload);
    const key = bindingKey(policy);
    if (key === null) continue;
    const existing = bindings.get(key);
    if (existing !== undefined) {
      throw new Error(`workloads ${existing} and ${policy.workload} declare the same identity`);
    }
    bindings.set(key, policy.workload);
  }

  const entries: PolicySnapshotEntry[] = policies.map(policy => ({
    workload: policy.workload,
    environments: [...policy.environments].sort(),
    identity: canonicalIdentity(policy),
    secrets: [...policy.secrets].sort(),
  }));
  const byWorkload = new Map(policies.map(policy => [policy.workload, policy]));

  // Hashes are kept as strings, never promises, so no request awaits a digest another request
  // started (workerd ties a promise to the request that created it).
  let policyHash: string | null = null;
  const workloadHashes = new Map<string, string>();
  return {
    all: () => policies,
    forEnvironment: environment =>
      policies.filter(policy => policy.environments.includes(environment)),
    has: workload => byWorkload.has(workload),
    get: (environment, workload) => {
      const policy = byWorkload.get(workload);
      if (!policy || !policy.environments.includes(environment)) return null;
      return policy;
    },
    snapshot: () => entries,
    hash: async () => (policyHash ??= await sha256Base64Url(JSON.stringify(entries))),
    workloadHash: async workload => {
      const cached = workloadHashes.get(workload);
      if (cached !== undefined) return cached;
      const secrets = [...(byWorkload.get(workload)?.secrets ?? [])].sort();
      const hash = await sha256Base64Url(JSON.stringify({ workload, secrets }));
      workloadHashes.set(workload, hash);
      return hash;
    },
  };
}
