import {
  MIGRATION_RUN_GRANT,
  type StsEnvironment,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import { parse } from 'yaml';
import type { CloudflareDeployPins } from '../constants';
import { sha256Base64Url } from '../crypto/hash';
import {
  PolicySchema,
  RegistrationSchema,
  effectivePolicy,
  holdsMigrationRun,
  isLeaseDynamicGrant,
  isRegistrationDocument,
  policyFileProblems,
  vercelEnvironmentKey,
  type DynamicGrant,
  type Policy,
} from './schema';

/**
 * One policy as `RefresherDO` stores it to diff the next policy change against, as STS applies it
 * in the refresher's environment: an environment's own grants appear merged into the lists, never
 * as a field, so a rollback's strict parser reads the entry. A policy without token grants leaves
 * out `audiences` and `scopes`, so its entry keeps the format of the version before token grants.
 */
export type PolicySnapshotEntry = {
  workload: string;
  environments: string[];
  identity: string;
  secrets: string[];
  audiences?: string[];
  scopes?: string[];
  /**
   * One `<grant>:<maxTtlSeconds>:<defaultTtlSeconds>:<maxActive>` per lease grant, and one
   * `cloudflare-deploy:<permissionSet>:<ttlSeconds>:<maxActive>:<maxPerHour>:<groups>:<zones>` with
   * the first 8 characters of each sorted id, so a changed group or zone shows. Absent when the
   * policy has none, so the snapshot and its hash stay what a reader without leases expects (a
   * rollback to it then parses the stored snapshot).
   */
  dynamic?: string[];
};

function dynamicKey(entry: DynamicGrant): string {
  if (isLeaseDynamicGrant(entry)) {
    return `${entry.grant}:${entry.maxTtlSeconds}:${entry.defaultTtlSeconds}:${entry.maxActive}`;
  }
  if (entry.grant === MIGRATION_RUN_GRANT) return entry.grant;
  const short = (ids: string[]) =>
    [...ids]
      .sort()
      .map(id => id.slice(0, 8))
      .join('+');
  const groups = short(entry.permissionGroups.map(group => group.id));
  return `${entry.grant}:${entry.permissionSet}:${entry.ttlSeconds}:${entry.maxActive}:${entry.maxPerHour}:${groups}:${short(entry.zones)}`;
}

/**
 * The loaded policies. Every per-environment read (`get`, `forEnvironment`, `snapshot`, `hash`,
 * `workloadHash`) answers with each policy's base grants plus that environment's own; `all` returns
 * the files as written, for identity matching only. A registration is in none of these: STS
 * answers for a registered name exactly as for a name with no file. `registered` lists the
 * registered names, for the repository checks only.
 */
export type PolicyIndex = {
  all(): Policy[];
  forEnvironment(environment: StsEnvironment): Policy[];
  has(workload: string): boolean;
  get(environment: StsEnvironment, workload: string): Policy | null;
  snapshot(environment: StsEnvironment): PolicySnapshotEntry[];
  hash(environment: StsEnvironment): Promise<string>;
  /** Hash of one workload's secret grants; a bundle built under another hash is out of date. */
  workloadHash(environment: StsEnvironment, workload: string): Promise<string>;
  registered(): readonly string[];
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
      return `github-oidc|${identity.repository}|${identity.repositoryId}|${identity.repositoryOwnerId}|${identity.environment ?? ''}|${sortedList(identity.refs)}|${sortedList(identity.jobWorkflowRefs)}|${sortedList(identity.events)}${identity.legacySubject === true ? '|legacy-subject' : ''}`;
    case 'vercel-oidc':
      return `vercel-oidc|${identity.teamSlug}|${identity.teamId}|${identity.projectId}|${identity.projectName}|${sortedList(identity.environments.map(vercelEnvironmentKey))}`;
  }
}

/**
 * The keys under which a policy accepts a provider token; two policies with a common key would both
 * match one token, so loading refuses them. A GitHub policy has one key per workflow file: several
 * policies share a repository, each for its own environment and workflows.
 */
function bindingKeys(policy: Policy): string[] {
  const identity = policy.identity;
  switch (identity.kind) {
    case 'worker-binding':
      return [];
    case 'fly-oidc':
      return [`fly-oidc|${identity.orgId}|${identity.appId}`];
    case 'github-oidc':
      return identity.jobWorkflowRefs.map(
        workflow =>
          `github-oidc|${identity.repositoryOwnerId}|${identity.repositoryId}|${identity.environment ?? ''}|${workflow}`
      );
    case 'vercel-oidc':
      return [`vercel-oidc|${identity.teamId}|${identity.projectId}`];
  }
}

/**
 * The workflow files a policy's GitHub identity names, whatever its GitHub environment. A
 * trigger-only policy's files belong to it alone (README "Migration run attestation"): no other
 * policy, in any environment, may name one, so no token of that workflow file opens anything else.
 */
function workflowKeys(policy: Policy): string[] {
  const identity = policy.identity;
  if (identity.kind !== 'github-oidc') return [];
  return identity.jobWorkflowRefs.map(
    workflow => `${identity.repositoryOwnerId}|${identity.repositoryId}|${workflow}`
  );
}

/**
 * `scopeRegistry` is the registry token grants are checked against, and `cloudflareDeployPins` the
 * Cloudflare permission groups and zones deploy grants are checked against (default
 * `CLOUDFLARE_DEPLOY_PINS`); tests pass their own.
 */
export function loadPolicies(
  sources: Record<string, string>,
  options: {
    scopeRegistry?: StsScopeRegistry;
    cloudflareDeployPins?: CloudflareDeployPins;
  } = {}
): PolicyIndex {
  const policies: Policy[] = [];
  const registered: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    let document: unknown;
    try {
      document = parse(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown parse error';
      throw new Error(`${file} is not valid YAML: ${detail}`);
    }
    if (isRegistrationDocument(document)) {
      const registration = RegistrationSchema.safeParse(document);
      if (!registration.success) {
        throw new Error(
          `${file} does not match the registration schema: ${registration.error.message}`
        );
      }
      const { workload } = registration.data;
      if (file !== `${workload}.yaml`) {
        throw new Error(`${file} must be named ${workload}.yaml after its workload`);
      }
      registered.push(workload);
      continue;
    }
    const parsed = PolicySchema.safeParse(document);
    if (!parsed.success) {
      throw new Error(`${file} does not match the policy schema: ${parsed.error.message}`);
    }
    const policy = parsed.data;
    const problems = policyFileProblems(
      policy,
      options.scopeRegistry,
      options.cloudflareDeployPins
    );
    if (problems.length > 0) {
      throw new Error(`${file} is invalid: ${problems.join('; ')}`);
    }
    if (file !== `${policy.workload}.yaml`) {
      throw new Error(`${file} must be named ${policy.workload}.yaml after its workload`);
    }
    policies.push(policy);
  }
  policies.sort((left, right) => left.workload.localeCompare(right.workload));
  registered.sort((left, right) => left.localeCompare(right));

  const workloads = new Set<string>();
  const bindings = new Map<string, string>();
  for (const policy of policies) {
    if (workloads.has(policy.workload)) {
      throw new Error(`more than one policy file declares workload ${policy.workload}`);
    }
    workloads.add(policy.workload);
    for (const key of bindingKeys(policy)) {
      const existing = bindings.get(key);
      if (existing !== undefined) {
        throw new Error(`workloads ${existing} and ${policy.workload} declare the same identity`);
      }
      bindings.set(key, policy.workload);
    }
  }
  for (const workload of registered) {
    if (workloads.has(workload)) {
      throw new Error(`more than one policy file declares workload ${workload}`);
    }
    workloads.add(workload);
  }

  const triggerWorkflows = new Map<string, string>();
  for (const policy of policies.filter(holdsMigrationRun)) {
    for (const key of workflowKeys(policy)) triggerWorkflows.set(key, policy.workload);
  }
  for (const policy of policies) {
    for (const key of workflowKeys(policy)) {
      const owner = triggerWorkflows.get(key);
      if (owner !== undefined && owner !== policy.workload) {
        throw new Error(
          `workload ${policy.workload} names a workflow file of the trigger-only workload ${owner}`
        );
      }
    }
  }

  const snapshotEntry = (policy: Policy): PolicySnapshotEntry => ({
    workload: policy.workload,
    environments: [...policy.environments].sort(),
    identity: canonicalIdentity(policy),
    secrets: [...policy.secrets].sort(),
    ...(policy.audiences.length > 0 ? { audiences: [...policy.audiences].sort() } : {}),
    ...(policy.scopes.length > 0 ? { scopes: [...policy.scopes].sort() } : {}),
    ...(policy.dynamic.length > 0 ? { dynamic: policy.dynamic.map(dynamicKey).sort() } : {}),
  });
  const byWorkload = new Map(policies.map(policy => [policy.workload, policy]));

  // Each environment's view is built once, on first use, so no request allocates a merged policy.
  type EnvironmentView = {
    served: Policy[];
    servedByWorkload: Map<string, Policy>;
    entries: PolicySnapshotEntry[];
  };
  const views = new Map<StsEnvironment, EnvironmentView>();
  const viewOf = (environment: StsEnvironment): EnvironmentView => {
    const cached = views.get(environment);
    if (cached !== undefined) return cached;
    const applied = policies.map(policy => effectivePolicy(policy, environment));
    const served = applied.filter(policy => policy.environments.includes(environment));
    const view = {
      served,
      servedByWorkload: new Map(served.map(policy => [policy.workload, policy])),
      // Every policy, as the version before environment grants wrote it, so a deploy that adds
      // none changes no stored snapshot.
      entries: applied.map(snapshotEntry),
    };
    views.set(environment, view);
    return view;
  };

  // Hashes are kept as strings, never promises, so no request awaits a digest another request
  // started (workerd ties a promise to the request that created it).
  const policyHashes = new Map<StsEnvironment, string>();
  const workloadHashes = new Map<string, string>();
  return {
    all: () => policies,
    forEnvironment: environment => viewOf(environment).served,
    has: workload => byWorkload.has(workload),
    get: (environment, workload) => viewOf(environment).servedByWorkload.get(workload) ?? null,
    snapshot: environment => viewOf(environment).entries,
    hash: async environment => {
      const cached = policyHashes.get(environment);
      if (cached !== undefined) return cached;
      const hash = await sha256Base64Url(JSON.stringify(viewOf(environment).entries));
      policyHashes.set(environment, hash);
      return hash;
    },
    workloadHash: async (environment, workload) => {
      const key = `${environment}|${workload}`;
      const cached = workloadHashes.get(key);
      if (cached !== undefined) return cached;
      const policy = byWorkload.get(workload);
      const secrets = [...(policy ? effectivePolicy(policy, environment).secrets : [])].sort();
      const hash = await sha256Base64Url(JSON.stringify({ workload, secrets }));
      workloadHashes.set(key, hash);
      return hash;
    },
    registered: () => registered,
  };
}
