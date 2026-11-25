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
};

function canonicalIdentity(policy: Policy): string {
  const identity = policy.identity;
  switch (identity.kind) {
    case 'worker-binding':
      return 'worker-binding';
    case 'vercel-oidc':
      return `vercel-oidc|${identity.teamSlug}|${identity.projectId}|${[...identity.vercelEnvironments].sort().join(',')}`;
    case 'fly-oidc':
      return `fly-oidc|${identity.org}|${identity.app}`;
    case 'github-oidc':
      return `github-oidc|${identity.repositoryId}|${identity.repositoryOwnerId}|${[...(identity.refs ?? [])].sort().join(',')}|${[...(identity.environments ?? [])].sort().join(',')}`;
  }
}

function bindingKey(policy: Policy): string | null {
  const identity = policy.identity;
  switch (identity.kind) {
    case 'worker-binding':
      return null;
    case 'vercel-oidc':
      return `vercel-oidc|${identity.teamSlug}|${identity.projectId}`;
    case 'fly-oidc':
      return `fly-oidc|${identity.org}|${identity.app}`;
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

  let hashPromise: Promise<string> | null = null;
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
    hash: () => {
      hashPromise ??= sha256Base64Url(JSON.stringify(entries));
      return hashPromise;
    },
  };
}
