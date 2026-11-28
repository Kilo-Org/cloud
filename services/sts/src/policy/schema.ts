import {
  AudienceSchema,
  CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS,
  CLOUDFLARE_DEPLOY_MIN_TTL_SECONDS,
  LEASE_GRANT_MAX_TTL_SECONDS,
  LEASE_MIN_TTL_SECONDS,
  LeaseGrantSchema,
  MIGRATION_RUN_GRANT,
  STS_RESERVED_SCOPES,
  STS_SCOPE_REGISTRY,
  ScopeSchema,
  SecretNameSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  type LeaseGrant,
  type StsEnvironment,
  isRegisteredStsScope,
  scopeAudience,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import { z } from 'zod';
import {
  CLOUDFLARE_ACCOUNT_SHARED_ACROSS_ENVIRONMENTS,
  CLOUDFLARE_DEPLOY_PINS,
  type CloudflareDeployPins,
  DEPLOY_TOKEN_ACCOUNT_MAX_OUTSTANDING,
  MINTING_FOLDER,
  MINTING_SECRET_NAMES,
} from '../constants';

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const StableIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const NumericIdSchema = z.string().regex(/^[0-9]{1,20}$/);
const RefSchema = z.string().regex(/^refs\/[A-Za-z0-9._/-]{1,200}$/);
/** GitHub's own limits: an owner name of up to 39 characters, a repository name of up to 100. */
const GithubRepositorySchema = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
/** Plain names only, so the token's `sub` carries the name as written, with nothing escaped. */
const GithubEnvironmentSchema = z.string().regex(/^[A-Za-z0-9._-]{1,255}$/);
/**
 * At most 512 characters: the delivery row records a verified token's `job_workflow_ref`, which
 * equals one of these, as one audit attribute, and an attribute string holds at most 512.
 */
export const JobWorkflowRefSchema = z
  .string()
  .max(512)
  .regex(
    /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[A-Za-z0-9._-]{1,200}\.ya?ml@refs\/[A-Za-z0-9._/-]{1,200}$/
  );

/**
 * The events a GitHub policy may accept, an allowlist (kilocode CI design 3.1). Every event a fork
 * author can start (`pull_request`, `pull_request_target`, `issues`, `issue_comment`,
 * `pull_request_review`, `discussion`, `merge_group` and the rest) is in no list, so no policy can
 * accept it. `workflow_run` runs with the base repository's privileges after a run that a pull
 * request, even a fork's, may have started, and its token names the default branch whatever that
 * run was, so a policy that accepts it accepts nothing else and grants no production.
 */
export const GITHUB_EVENTS = ['push', 'schedule', 'workflow_dispatch', 'workflow_run'] as const;

/** A production GitHub policy accepts only jobs that run on this ref (design 4.2). */
export const GITHUB_PRODUCTION_REF = 'refs/heads/main';

/**
 * The production GitHub policies that may accept a ref other than `GITHUB_PRODUCTION_REF`, each
 * pinned to the whole policy: its workload, repository and ids, GitHub environment, one ref, one
 * workflow file at that ref, events, and exactly its secrets, with no token, dynamic or
 * environment grant. A policy that differs in any field is refused like any other production
 * policy off `main`. Today it holds one entry:
 *
 * - `ci-kilocode-app-key-v2` (manager ruling M76, the pattern of M62's v2 publish rule): the
 *   `progress-commit` job of kilocode's `kilo-v2.yml` on `v2`, which opens the progress-map pull
 *   request with the Kilo Maintainer app. The job runs only on a push to `v2`; the `automation`
 *   environment admits deployments from `main` and `v2` alone.
 */
export const GITHUB_PRODUCTION_REF_EXCEPTIONS = [
  {
    workload: 'ci-kilocode-app-key-v2',
    repository: 'Kilo-Org/kilocode',
    repositoryId: '946087422',
    repositoryOwnerId: '201822503',
    environment: 'automation',
    refs: ['refs/heads/v2'],
    jobWorkflowRefs: ['Kilo-Org/kilocode/.github/workflows/kilo-v2.yml@refs/heads/v2'],
    events: ['push'],
    environments: ['production'],
    secrets: ['KILOCODE_MAINTAINER_APP_KEY'],
  },
] as const;

/** Equal lists in the same order; the exception pins each list exactly as written. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The bundle folder of a GitHub policy is `/ci/<workload>`, so its name starts with this. */
export const GITHUB_WORKLOAD_PREFIX = 'ci-';

export const WorkerBindingIdentitySchema = z.strictObject({
  kind: z.literal('worker-binding'),
});

/**
 * Fly machine tokens (https://fly.io/docs/security/openid-connect/). The org slug picks the issuer;
 * the stable `org_id` and `app_id` claims bind the identity, so a renamed or recreated app with
 * the same name is refused.
 */
export const FlyIdentitySchema = z.strictObject({
  kind: z.literal('fly-oidc'),
  org: SlugSchema,
  orgId: StableIdSchema,
  app: SlugSchema,
  appId: StableIdSchema,
});

/**
 * GitHub Actions job tokens (https://docs.github.com/en/actions/reference/security/oidc). The
 * repository and owner ids bind the identity; `repository` (`<owner>/<name>`) builds the exact
 * immutable-format subject the token must carry. `environment` is the one GitHub environment the
 * policy trusts, required for production and for any token grant. `jobWorkflowRefs` lists every
 * workflow file whose jobs may use the policy, each with its ref; a called reusable workflow is its
 * own entry, because its jobs carry its own `job_workflow_ref`.
 */
export const GithubIdentitySchema = z.strictObject({
  kind: z.literal('github-oidc'),
  repository: GithubRepositorySchema,
  repositoryId: NumericIdSchema,
  repositoryOwnerId: NumericIdSchema,
  environment: GithubEnvironmentSchema.optional(),
  refs: z.array(RefSchema).min(1).max(32).default([GITHUB_PRODUCTION_REF]),
  jobWorkflowRefs: z.array(JobWorkflowRefSchema).min(1).max(32),
  events: z.array(z.enum(GITHUB_EVENTS)).min(1).max(GITHUB_EVENTS.length),
  /** Accept GitHub's default (name-only) subject too; see `GITHUB_LEGACY_SUBJECT_REPOSITORY`. */
  legacySubject: z.literal(true).optional(),
});

export type GithubIdentity = z.infer<typeof GithubIdentitySchema>;

/**
 * The one repository whose policies may set `legacySubject` (decision 2026-11-27): Kilo-Org/kilocode.
 * Its tokens still carry the default subject `repo:Kilo-Org/kilocode:environment:<env>`, so STS
 * accepts that form for it; the token's `repository_id` and `repository_owner_id` claims must still
 * equal these ids, and every other binding still applies, so a renamed or recreated repository with
 * the same name is refused.
 *
 * WHY: npm/cli#9969 (open): npm trusted publishing fails with "package not found" for repositories
 * using use_immutable_subject, so kilocode cannot turn it on without breaking npm releases; Azure
 * signing (its federated credential matches `sub`) also needs a new trust entry before the switch.
 *
 * HOW TO UPGRADE: when npm fixes #9969 -> add the Azure federated credential for
 * `repo:Kilo-Org@201822503/kilocode@946087422:ref:refs/heads/main` -> turn on use_immutable_subject
 * for kilocode -> prove oidc_check on main and v2 -> delete this exception (this constant, the
 * `legacySubject` field and its loader check, `githubLegacySubject`, and the flag in the eight
 * `ci-kilocode-*` policies).
 */
export const GITHUB_LEGACY_SUBJECT_REPOSITORY = {
  repository: 'Kilo-Org/kilocode',
  repositoryId: '946087422',
  repositoryOwnerId: '201822503',
} as const;

/**
 * The `sub` a token for this identity must carry: GitHub's immutable format, which names the owner
 * and repository ids next to the names. A job with an environment carries the environment form; any
 * other job carries the ref form for its `ref` claim.
 */
export function githubSubject(identity: GithubIdentity, ref: string): string {
  const [owner, name] = identity.repository.split('/');
  const repository = `repo:${owner}@${identity.repositoryOwnerId}/${name}@${identity.repositoryId}`;
  return identity.environment === undefined
    ? `${repository}:ref:${ref}`
    : `${repository}:environment:${identity.environment}`;
}

/** GitHub's default subject for a `legacySubject` policy: the immutable form without the ids. */
export function githubLegacySubject(identity: GithubIdentity, ref: string): string {
  const repository = `repo:${identity.repository}`;
  return identity.environment === undefined
    ? `${repository}:ref:${ref}`
    : `${repository}:environment:${identity.environment}`;
}

/**
 * The manager folder a policy's own secrets live in (design 4.2), under the root folder the
 * refresher reads; `/shared` is the fallback for every policy.
 */
export function bundleFolder(policy: Policy): { root: '/ci' | '/workloads'; path: string } {
  const root = policy.identity.kind === 'github-oidc' ? '/ci' : '/workloads';
  return { root, path: `${root}/${policy.workload}` };
}

/**
 * The Vercel environments a policy may list. `development` is not one: its tokens come from a
 * person's `vercel env pull` or `vercel dev`, not from a deployment. Any other `environment` claim
 * is a custom environment's slug, listed by its id.
 */
const VERCEL_STANDARD_ENVIRONMENTS = ['production', 'preview'] as const;

const VercelEnvironmentSchema = z.union([
  z.enum(VERCEL_STANDARD_ENVIRONMENTS),
  z.strictObject({ customEnvironmentId: StableIdSchema }),
]);

export type VercelEnvironment = z.infer<typeof VercelEnvironmentSchema>;

export const VERCEL_ISSUER_PREFIX = 'https://oidc.vercel.com/';

/**
 * Vercel function tokens after the custom-audience exchange (https://vercel.com/docs/oidc/reference).
 * The issuer is the team slug form `https://oidc.vercel.com/<teamSlug>`, the form the proof run
 * recorded on exchanged function tokens; the team id form is refused. The stable `owner_id`,
 * `project_id` and `environment` (or `custom_environment_id`) claims bind the identity;
 * `projectName` is for people reading the policy and never authorizes.
 */
export const VercelIdentitySchema = z.strictObject({
  kind: z.literal('vercel-oidc'),
  teamSlug: SlugSchema,
  teamId: z.string().regex(/^team_[A-Za-z0-9]{1,64}$/),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]{1,64}$/),
  projectName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  environments: z.array(VercelEnvironmentSchema).min(1).max(32),
});

/**
 * The STS environments a Vercel environment may read (design 6.2): only `production` reaches
 * production values; a preview runs code from any branch, so it reads development values; a custom
 * environment reads staging values only.
 */
export function vercelStsEnvironments(environment: VercelEnvironment): readonly StsEnvironment[] {
  if (typeof environment !== 'string') return ['staging'];
  return environment === 'production' ? ['production'] : ['development'];
}

export function vercelEnvironmentKey(environment: VercelEnvironment): string {
  return typeof environment === 'string'
    ? environment
    : `custom:${environment.customEnvironmentId}`;
}

export const PolicyIdentitySchema = z.discriminatedUnion('kind', [
  WorkerBindingIdentitySchema,
  FlyIdentitySchema,
  GithubIdentitySchema,
  VercelIdentitySchema,
]);

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * D53/M112 (manager ruling M112, 2026-11-27, extending Igor's D53): the Kilo-Org/cloud workflow
 * files whose secret-bundle policies may accept `workflow_run`, alone or with `schedule` and
 * `workflow_dispatch`, and grant production. D53 admits those triggers for trigger-only and
 * deploy-grant policies; these three jobs already receive the same values as stored GitHub secrets
 * on the same triggers, run main's workflow code in a GitHub environment that admits main alone,
 * and read no input from the upstream run beyond what their own guards check. A policy uses the
 * carve-out only when it is a Kilo-Org/cloud policy (ids below) on `refs/heads/main`, binds a
 * GitHub environment, names exactly one of these files, accepts no event beyond the three, holds
 * at least one secret, and grants no token, dynamic grant or environment grant. Removing a file
 * here makes its policy fail to load.
 */
export const D53_M112_CI_BUNDLE_CARVE_OUT = {
  repository: 'Kilo-Org/cloud',
  repositoryId: '1145038391',
  repositoryOwnerId: '201822503',
  jobWorkflowRefs: [
    'Kilo-Org/cloud/.github/workflows/stage-vercel-deployment.yml@refs/heads/main',
    'Kilo-Org/cloud/.github/workflows/promote-vercel-deployment.yml@refs/heads/main',
    'Kilo-Org/cloud/.github/workflows/cloud-agent-sentry-sourcemaps.yml@refs/heads/main',
  ],
} as const;

const CARVE_OUT_EVENTS: readonly string[] = ['workflow_run', 'schedule', 'workflow_dispatch'];

/** True for a secret-bundle policy inside `D53_M112_CI_BUNDLE_CARVE_OUT`. */
function usesCiBundleCarveOut(policy: Policy, identity: GithubIdentity): boolean {
  const carveOut = D53_M112_CI_BUNDLE_CARVE_OUT;
  const files: readonly string[] = carveOut.jobWorkflowRefs;
  return (
    identity.repository === carveOut.repository &&
    identity.repositoryId === carveOut.repositoryId &&
    identity.repositoryOwnerId === carveOut.repositoryOwnerId &&
    identity.environment !== undefined &&
    identity.refs.length === 1 &&
    identity.refs[0] === GITHUB_PRODUCTION_REF &&
    identity.jobWorkflowRefs.length === 1 &&
    files.includes(identity.jobWorkflowRefs[0] ?? '') &&
    identity.events.every(event => CARVE_OUT_EVENTS.includes(event)) &&
    policy.secrets.length > 0 &&
    policy.audiences.length === 0 &&
    policy.scopes.length === 0 &&
    policy.dynamic.length === 0 &&
    Object.keys(policy.environmentGrants).length === 0
  );
}

/**
 * The most active leases a policy may allow per grant: `replica-read` covers bouncer-watch's hourly
 * and daily runs, which overlap.
 */
export const LEASE_MAX_ACTIVE_CEILING: Readonly<Record<LeaseGrant, number>> = {
  'replica-read': 4,
};

/**
 * One database lease grant (design 6.3 `dynamic`): the Infisical dynamic secret, the longest and
 * the default lifetime a request gets, and how many leases of it the workload may hold at once.
 */
const LeaseDynamicGrantSchema = z.strictObject({
  grant: LeaseGrantSchema,
  maxTtlSeconds: z.number().int().min(LEASE_MIN_TTL_SECONDS),
  defaultTtlSeconds: z.number().int().min(LEASE_MIN_TTL_SECONDS),
  maxActive: z.number().int().min(1),
});

export type LeaseDynamicGrant = z.infer<typeof LeaseDynamicGrantSchema>;

export const CLOUDFLARE_DEPLOY_GRANT = 'cloudflare-deploy';

/** The most unexpired Cloudflare deploy tokens, and mints per hour, a policy may allow. */
export const CLOUDFLARE_DEPLOY_MAX_ACTIVE_CEILING = 3;
export const CLOUDFLARE_DEPLOY_MAX_PER_HOUR_CEILING = 12;

/**
 * The most mint requests one GitHub run attempt may make in an hour under a grant with
 * `maxPerRun`. Kilo-Org/cloud's deploy-workers.yml runs one job per changed Worker (31 today) in
 * parallel, each with its own token.
 */
export const CLOUDFLARE_DEPLOY_MAX_PER_RUN_CEILING = 64;

/**
 * Q71 carve-out for Cloudflare deploy grants (Q71b, decided by Igor 2026-11-27).
 * The workflow files whose deploy-only policies may accept `workflow_run` together with
 * `schedule` and `workflow_dispatch`, and grant production. Q71 refuses that elsewhere because
 * STS cannot see the upstream run. Here the deploy job already receives the stored
 * `CLOUDFLARE_API_TOKEN` on the same `workflow_run` trigger, runs main's workflow code and deploys
 * the commit that `check-deployment-changes.yml` (or the runtime publisher's admission) picked from
 * main, so a 1-hour token is no stronger than the stored token it replaces (Q65). A policy uses
 * the carve-out only when it is a Kilo-Org/cloud policy (ids below), binds a GitHub environment,
 * names only these files and holds nothing but its `cloudflare-deploy` grant.
 */
export const Q71_CLOUDFLARE_DEPLOY_CARVE_OUT = {
  repository: 'Kilo-Org/cloud',
  repositoryId: '1145038391',
  repositoryOwnerId: '201822503',
  jobWorkflowRefs: [
    'Kilo-Org/cloud/.github/workflows/deploy-workers.yml@refs/heads/main',
    'Kilo-Org/cloud/.github/workflows/cloud-agent-runtime-publish.yml@refs/heads/main',
  ],
} as const;

/** A Cloudflare account, zone or permission-group id: 32 lowercase hexadecimal characters. */
export const CloudflareIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * A permission group no deploy token may hold, matched on the name the policy declares: a token
 * that can create API tokens or manage members can make a credential that outlives the 1-hour
 * bound. A name check only catches a mistake; the pinned ids (`CLOUDFLARE_DEPLOY_PINS`), and the
 * check that Cloudflare names each returned id as the policy does, catch a group listed under
 * another name.
 */
const FORBIDDEN_PERMISSION_GROUP_NAME = /api[ _-]?tokens?|member/i;

/**
 * One Cloudflare permission group, by the id Cloudflare lists at
 * `GET /accounts/<account>/tokens/permission_groups`, resolved when the policy is written (README
 * "Cloudflare deploy tokens"). STS sends only the id. `name` is Cloudflare's name for that id: the
 * loader checks it against `FORBIDDEN_PERMISSION_GROUP_NAME`, and a minted token whose returned
 * name for the id differs is deleted. `scope` says which resource the group applies to: the account
 * of `CF_DEPLOY_ACCOUNT_ID`, or each listed zone.
 */
const CloudflarePermissionGroupSchema = z.strictObject({
  id: CloudflareIdSchema,
  name: z.string().min(1).max(100),
  scope: z.enum(['account', 'zone']),
});

/**
 * One Cloudflare deploy-token grant (design 4.5, 6.3 `dynamic`): the permission set a GitHub
 * deploy job's token carries, its lifetime, and the workload's limits. `intendedScripts` names the
 * Workers the job deploys (empty for a job that deploys none) and `intendedRoutes` the zone route
 * patterns it may add or change, for audit and review only: Cloudflare's API cannot limit an API
 * token to named Workers or routes, so the token can change every Worker and route its permission
 * groups reach in the account.
 */
export const CloudflareDeployGrantSchema = z.strictObject({
  grant: z.literal(CLOUDFLARE_DEPLOY_GRANT),
  permissionSet: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  permissionGroups: z.array(CloudflarePermissionGroupSchema).min(1).max(8),
  zones: z.array(CloudflareIdSchema).max(4).default([]),
  intendedScripts: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/))
    .max(64)
    .default([]),
  intendedRoutes: z.array(z.string().min(1).max(256)).max(16).default([]),
  ttlSeconds: z
    .number()
    .int()
    .min(CLOUDFLARE_DEPLOY_MIN_TTL_SECONDS)
    .max(CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS)
    .default(CLOUDFLARE_DEPLOY_MAX_TTL_SECONDS),
  maxActive: z.number().int().min(1),
  maxPerHour: z.number().int().min(1),
  /**
   * Counts `maxActive` and `maxPerHour` in GitHub run attempts (run id and attempt) instead of
   * tokens, and allows each run attempt this many mint requests per hour (`run_limit` beyond).
   * For a workflow whose parallel jobs each deploy with their own token; absent: one token each.
   */
  maxPerRun: z.number().int().min(1).max(CLOUDFLARE_DEPLOY_MAX_PER_RUN_CEILING).optional(),
});

export type CloudflareDeployGrant = z.infer<typeof CloudflareDeployGrantSchema>;

/**
 * The grant of a trigger-only policy (design Q64a): its GitHub job may start a migration run
 * through the migration proxy, which asks `attestGithubRun`, and nothing else. No other field: the
 * proxy holds the database login, never the job.
 */
const MigrationRunGrantSchema = z.strictObject({ grant: z.literal(MIGRATION_RUN_GRANT) });

export type MigrationRunGrant = z.infer<typeof MigrationRunGrantSchema>;

const DynamicGrantSchema = z.discriminatedUnion('grant', [
  LeaseDynamicGrantSchema,
  CloudflareDeployGrantSchema,
  MigrationRunGrantSchema,
]);

export type DynamicGrant = z.infer<typeof DynamicGrantSchema>;

export function isLeaseDynamicGrant(entry: DynamicGrant): entry is LeaseDynamicGrant {
  return LeaseGrantSchema.safeParse(entry.grant).success;
}

/** True for a trigger-only policy: one that holds the `migration-run` grant. */
export function holdsMigrationRun(policy: Policy): boolean {
  return policy.dynamic.some(entry => entry.grant === MIGRATION_RUN_GRANT);
}

/** The policy's lease entry for `grant`, or undefined when it lists none. */
export function leaseDynamicGrant(
  policy: Policy,
  grant: LeaseGrant
): LeaseDynamicGrant | undefined {
  return policy.dynamic.filter(isLeaseDynamicGrant).find(entry => entry.grant === grant);
}

/** The policy's Cloudflare deploy-token entry, or undefined when it lists none. */
export function cloudflareDeployGrant(policy: Policy): CloudflareDeployGrant | undefined {
  return policy.dynamic.find(
    (entry): entry is CloudflareDeployGrant => entry.grant === CLOUDFLARE_DEPLOY_GRANT
  );
}

/**
 * Grants a policy adds where STS runs in one environment only, on top of its base grants, under
 * the same rules (design 6.3). Activating a grant in another environment is a data change.
 */
const EnvironmentGrantsSchema = z.strictObject({
  audiences: z.array(AudienceSchema.max(63)).max(64).default([]),
  scopes: z.array(ScopeSchema.max(127)).max(256).default([]),
  secrets: z.array(SecretNameSchema).max(256).default([]),
});

export const PolicySchema = z.strictObject({
  workload: WorkloadNameSchema,
  environments: z.array(StsEnvironmentSchema).min(1).max(3),
  identity: PolicyIdentitySchema,
  secrets: z.array(SecretNameSchema).max(256),
  /** Services this workload may mint a token for; empty mints nothing (default deny). */
  audiences: z.array(AudienceSchema.max(63)).max(64).default([]),
  /** Scopes it may hold, each from `STS_SCOPE_REGISTRY` and under one of `audiences`. */
  scopes: z.array(ScopeSchema.max(127)).max(256).default([]),
  /**
   * Database leases and CI deploy tokens it may request, one entry per grant; empty requests none
   * (default deny).
   */
  dynamic: z
    .array(DynamicGrantSchema)
    .max(LeaseGrantSchema.options.length + 2)
    .default([]),
  /** Grants for one STS environment only, each key one of `environments`; absent adds none. */
  environmentGrants: z
    .strictObject({
      development: EnvironmentGrantsSchema.optional(),
      staging: EnvironmentGrantsSchema.optional(),
      production: EnvironmentGrantsSchema.optional(),
    })
    .default({}),
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyIdentity = z.infer<typeof PolicyIdentitySchema>;

/**
 * A workload name reserved for a later policy: no environment, identity or grant, so STS serves,
 * admits, bundles, audits and hashes nothing for it, exactly as for a name with no file. The
 * workload's own change replaces `registered` and the empty `secrets` with a policy, which then
 * passes every policy and binding check.
 */
export const RegistrationSchema = z.strictObject({
  workload: WorkloadNameSchema,
  registered: z.literal(true),
  secrets: z.tuple([]),
});

/** A file that sets `registered` at all is read as a registration, never as a policy. */
export function isRegistrationDocument(document: unknown): boolean {
  return typeof document === 'object' && document !== null && Object.hasOwn(document, 'registered');
}

/**
 * The policy as STS applies it in `environment`: its base grants plus that environment's own, with
 * no `environmentGrants` left, so a reader of the result sees only what this environment grants.
 */
export function effectivePolicy(policy: Policy, environment: StsEnvironment): Policy {
  if (Object.keys(policy.environmentGrants).length === 0) return policy;
  const extra = policy.environmentGrants[environment];
  return {
    ...policy,
    audiences: [...policy.audiences, ...(extra?.audiences ?? [])],
    scopes: [...policy.scopes, ...(extra?.scopes ?? [])],
    secrets: [...policy.secrets, ...(extra?.secrets ?? [])],
    environmentGrants: {},
  };
}

export const PolicySnapshotEntrySchema = z.strictObject({
  workload: z.string(),
  environments: z.array(z.string()),
  identity: z.string(),
  secrets: z.array(z.string()),
  // Left out for a policy without token grants, and in a snapshot stored before grants existed.
  audiences: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  // Written only for a policy with lease grants, so a reader from before leases parses the rest.
  dynamic: z.array(z.string()).optional(),
});

export const PolicySnapshotSchema = z.array(PolicySnapshotEntrySchema);

/**
 * Dynamic grants (design 6.3): at most one entry per grant, lease lifetimes within the grant's
 * ceiling, and each grant only for the identity it was built for. `replica-read` serves Workers in
 * the account (bouncer-watch); `cloudflare-deploy` and `migration-run` serve GitHub jobs.
 */
function dynamicProblems(policy: Policy, pins: CloudflareDeployPins): string[] {
  const problems: string[] = [];
  if (hasDuplicates(policy.dynamic.map(entry => entry.grant))) {
    problems.push('dynamic lists a grant twice');
  }
  for (const entry of policy.dynamic) {
    if (entry.grant === CLOUDFLARE_DEPLOY_GRANT) {
      problems.push(...cloudflareDeployProblems(policy, entry, pins));
      continue;
    }
    if (entry.grant === MIGRATION_RUN_GRANT) {
      problems.push(...migrationRunProblems(policy));
      continue;
    }
    const ceiling = LEASE_GRANT_MAX_TTL_SECONDS[entry.grant];
    if (entry.maxTtlSeconds > ceiling) {
      problems.push(`dynamic ${entry.grant}: maxTtlSeconds is above ${ceiling}`);
    }
    if (entry.defaultTtlSeconds > entry.maxTtlSeconds) {
      problems.push(`dynamic ${entry.grant}: defaultTtlSeconds is above maxTtlSeconds`);
    }
    if (entry.maxActive > LEASE_MAX_ACTIVE_CEILING[entry.grant]) {
      problems.push(
        `dynamic ${entry.grant}: maxActive is above ${LEASE_MAX_ACTIVE_CEILING[entry.grant]}`
      );
    }
    if (entry.grant === 'replica-read' && policy.identity.kind !== 'worker-binding') {
      problems.push('dynamic replica-read is only for a worker-binding policy');
    }
  }
  return problems;
}

/**
 * A trigger-only policy (design Q64a): a GitHub job bound to a protected GitHub environment (a
 * production one accepts `refs/heads/main` alone, checked with the other GitHub rules) that may
 * start a migration run and hold nothing else: no secret, token grant, other dynamic grant or
 * environment grant. A token of its job then opens nothing at STS but `attestGithubRun`.
 */
function migrationRunProblems(policy: Policy): string[] {
  const problems: string[] = [];
  const { identity } = policy;
  if (identity.kind !== 'github-oidc') {
    problems.push(`dynamic ${MIGRATION_RUN_GRANT} is only for a github-oidc policy`);
  } else {
    if (identity.environment === undefined) {
      problems.push(
        `a github-oidc policy with dynamic ${MIGRATION_RUN_GRANT} must bind identity.environment`
      );
    }
    // In every environment: the job only triggers a run of what is on `main`, so no other ref has
    // a reason to trigger one.
    if (identity.refs.length !== 1 || identity.refs[0] !== GITHUB_PRODUCTION_REF) {
      problems.push(
        `a github-oidc policy with dynamic ${MIGRATION_RUN_GRANT} accepts only ${GITHUB_PRODUCTION_REF}`
      );
    }
  }
  if (
    policy.secrets.length > 0 ||
    policy.audiences.length > 0 ||
    policy.scopes.length > 0 ||
    policy.dynamic.length > 1 ||
    Object.keys(policy.environmentGrants).length > 0
  ) {
    problems.push(`a policy with dynamic ${MIGRATION_RUN_GRANT} holds nothing else`);
  }
  return problems;
}

/**
 * A Cloudflare deploy-token grant serves only a GitHub job bound to a protected GitHub environment.
 * While staging and production share one Cloudflare account
 * (`CLOUDFLARE_ACCOUNT_SHARED_ACROSS_ENVIRONMENTS`), a staging token reaches production Workers, so
 * every such grant, in every environment, accepts `refs/heads/main` alone. Every group must be one
 * of `pins.allowedGroups` with the same scope, and none may administer tokens or members, by its
 * declared name or by an id in `pins.forbiddenGroupIds`. Every zone must be in
 * `pins.allowedZones` of every environment the policy grants; every zone-scoped group needs a zone,
 * and every zone a zone-scoped group.
 */
function cloudflareDeployProblems(
  policy: Policy,
  entry: CloudflareDeployGrant,
  pins: CloudflareDeployPins
): string[] {
  const problems: string[] = [];
  const { identity } = policy;
  if (identity.kind !== 'github-oidc') {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT} is only for a github-oidc policy`);
  } else {
    if (identity.environment === undefined) {
      problems.push(
        `a github-oidc policy with dynamic ${CLOUDFLARE_DEPLOY_GRANT} must bind identity.environment`
      );
    }
    if (
      CLOUDFLARE_ACCOUNT_SHARED_ACROSS_ENVIRONMENTS &&
      identity.refs.some(ref => ref !== GITHUB_PRODUCTION_REF)
    ) {
      problems.push(
        `a github-oidc policy with dynamic ${CLOUDFLARE_DEPLOY_GRANT} accepts only ${GITHUB_PRODUCTION_REF}: staging and production share one Cloudflare account`
      );
    }
  }
  if (entry.maxActive > CLOUDFLARE_DEPLOY_MAX_ACTIVE_CEILING) {
    problems.push(
      `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: maxActive is above ${CLOUDFLARE_DEPLOY_MAX_ACTIVE_CEILING}`
    );
  }
  if (entry.maxPerHour > CLOUDFLARE_DEPLOY_MAX_PER_HOUR_CEILING) {
    problems.push(
      `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: maxPerHour is above ${CLOUDFLARE_DEPLOY_MAX_PER_HOUR_CEILING}`
    );
  }
  if (entry.maxPerHour < entry.maxActive) {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT}: maxPerHour is below maxActive`);
  }
  // Under maxPerRun every active run may hold maxPerRun tokens at once; together they must fit in
  // this environment's share of the account's tokens.
  if (
    entry.maxPerRun !== undefined &&
    entry.maxActive * entry.maxPerRun > DEPLOY_TOKEN_ACCOUNT_MAX_OUTSTANDING
  ) {
    problems.push(
      `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: maxActive times maxPerRun is above ${DEPLOY_TOKEN_ACCOUNT_MAX_OUTSTANDING}`
    );
  }
  if (hasDuplicates(entry.permissionGroups.map(group => group.id))) {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT}: permissionGroups lists a group twice`);
  }
  if (hasDuplicates(entry.zones)) {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT}: zones contains a duplicate`);
  }
  if (hasDuplicates(entry.intendedScripts)) {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT}: intendedScripts contains a duplicate`);
  }
  if (hasDuplicates(entry.intendedRoutes)) {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT}: intendedRoutes contains a duplicate`);
  }
  for (const group of entry.permissionGroups) {
    if (FORBIDDEN_PERMISSION_GROUP_NAME.test(group.name)) {
      problems.push(
        `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: permission group ${group.name} administers tokens or members`
      );
    }
    if (pins.forbiddenGroupIds.includes(group.id)) {
      problems.push(
        `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: permission group ${group.id} is a forbidden group (CLOUDFLARE_DEPLOY_PINS)`
      );
    }
    if (
      !pins.allowedGroups.some(allowed => allowed.id === group.id && allowed.scope === group.scope)
    ) {
      problems.push(
        `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: permission group ${group.id} (${group.scope}) is not an allowed deploy group (CLOUDFLARE_DEPLOY_PINS)`
      );
    }
  }
  for (const zone of entry.zones) {
    for (const environment of policy.environments) {
      if (!pins.allowedZones[environment].includes(zone)) {
        problems.push(
          `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: zone ${zone} is not an allowed ${environment} zone (CLOUDFLARE_DEPLOY_PINS)`
        );
      }
    }
  }
  const zoneScoped = entry.permissionGroups.some(group => group.scope === 'zone');
  if (zoneScoped && entry.zones.length === 0) {
    problems.push(`dynamic ${CLOUDFLARE_DEPLOY_GRANT}: a zone-scoped permission group needs zones`);
  }
  if (!zoneScoped && entry.zones.length > 0) {
    problems.push(
      `dynamic ${CLOUDFLARE_DEPLOY_GRANT}: zones without a zone-scoped permission group`
    );
  }
  return problems;
}

/**
 * Token grants: every scope registered and under a listed audience, every audience used. A
 * reserved scope (`STS_RESERVED_SCOPES`, today the canary's denied probe) and its audience are
 * refused whatever the registry says, so STS denies every request for one.
 */
function grantProblems(policy: Policy, registry: StsScopeRegistry): string[] {
  const problems: string[] = [];
  if (hasDuplicates(policy.audiences)) problems.push('audiences contains a duplicate');
  if (hasDuplicates(policy.scopes)) problems.push('scopes contains a duplicate');
  for (const scope of policy.scopes) {
    const audience = scopeAudience(scope);
    if (STS_RESERVED_SCOPES.includes(scope)) {
      problems.push(`scope ${scope} is reserved and no policy may grant it`);
    }
    if (!isRegisteredStsScope(audience, scope, registry)) {
      problems.push(`scope ${scope} is not in STS_SCOPE_REGISTRY`);
    }
    if (!policy.audiences.includes(audience)) {
      problems.push(
        `scope ${scope} belongs to audience ${audience}, which audiences does not list`
      );
    }
  }
  for (const audience of policy.audiences) {
    if (STS_RESERVED_SCOPES.some(scope => scopeAudience(scope) === audience)) {
      problems.push(`audience ${audience} is reserved and no policy may grant it`);
    }
    if (audience === policy.workload) {
      problems.push(`audience ${audience} is the workload itself`);
    }
    if (!policy.scopes.some(scope => scopeAudience(scope) === audience)) {
      problems.push(`audience ${audience} has no scope`);
    }
  }
  return problems;
}

/**
 * True for a policy inside `Q71_CLOUDFLARE_DEPLOY_CARVE_OUT` (Q71b): a Kilo-Org/cloud
 * policy, by its ids, bound to a GitHub environment, naming only the carved-out workflow files,
 * accepting nothing beyond `workflow_run`, `schedule` and `workflow_dispatch`, and holding its
 * `cloudflare-deploy` grant and nothing else.
 */
function usesCloudflareDeployCarveOut(policy: Policy, identity: GithubIdentity): boolean {
  const carveOut = Q71_CLOUDFLARE_DEPLOY_CARVE_OUT;
  const files: readonly string[] = carveOut.jobWorkflowRefs;
  return (
    identity.repository === carveOut.repository &&
    identity.repositoryId === carveOut.repositoryId &&
    identity.repositoryOwnerId === carveOut.repositoryOwnerId &&
    identity.environment !== undefined &&
    identity.jobWorkflowRefs.every(entry => files.includes(entry)) &&
    identity.events.every(event => event !== 'push') &&
    policy.dynamic.length === 1 &&
    cloudflareDeployGrant(policy) !== undefined &&
    policy.secrets.length === 0 &&
    policy.audiences.length === 0 &&
    policy.scopes.length === 0 &&
    Object.keys(policy.environmentGrants).length === 0
  );
}

const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

function githubProblems(policy: Policy, identity: GithubIdentity): string[] {
  const problems: string[] = [];
  if (!policy.workload.startsWith(GITHUB_WORKLOAD_PREFIX)) {
    problems.push(
      `a github-oidc workload is named ${GITHUB_WORKLOAD_PREFIX}<job>; its bundle folder is /ci/<workload>`
    );
  }
  if (
    identity.legacySubject === true &&
    (identity.repository !== GITHUB_LEGACY_SUBJECT_REPOSITORY.repository ||
      identity.repositoryId !== GITHUB_LEGACY_SUBJECT_REPOSITORY.repositoryId ||
      identity.repositoryOwnerId !== GITHUB_LEGACY_SUBJECT_REPOSITORY.repositoryOwnerId)
  ) {
    problems.push(
      `identity.legacySubject is allowed only for ${GITHUB_LEGACY_SUBJECT_REPOSITORY.repository} (repository id ${GITHUB_LEGACY_SUBJECT_REPOSITORY.repositoryId}, owner id ${GITHUB_LEGACY_SUBJECT_REPOSITORY.repositoryOwnerId})`
    );
  }
  if (hasDuplicates(identity.refs)) problems.push('identity.refs contains a duplicate');
  if (hasDuplicates(identity.jobWorkflowRefs)) {
    problems.push('identity.jobWorkflowRefs contains a duplicate');
  }
  if (hasDuplicates(identity.events)) problems.push('identity.events contains a duplicate');
  // Q71 carve-out (Igor, 2026-11-27): a trigger-only policy holds nothing a token could read; its
  // job only asks the migration proxy to apply what is on `main`, which the proxy checks itself
  // (design Q64a). So it alone may list workflow_run with other events and grant production.
  // Q71b (Igor, 2026-11-27): the deploy-only policies of Q71_CLOUDFLARE_DEPLOY_CARVE_OUT may too.
  // D53/M112: the secret-bundle policies of D53_M112_CI_BUNDLE_CARVE_OUT may too.
  const carvedOut =
    holdsMigrationRun(policy) ||
    usesCloudflareDeployCarveOut(policy, identity) ||
    usesCiBundleCarveOut(policy, identity);
  if (!carvedOut && identity.events.includes('workflow_run') && identity.events.length > 1) {
    problems.push('a github-oidc policy that accepts workflow_run accepts no other event');
  }
  // A workflow_run job follows a run a pull request may have started, and its token carries the
  // default branch whatever that run was; only an environment's protection rules stand between it
  // and the policy's values, in any STS environment. STS cannot see the upstream run, so no
  // production policy accepts it, except a carved-out one.
  if (identity.events.includes('workflow_run') && identity.environment === undefined) {
    problems.push('a github-oidc policy that accepts workflow_run must bind identity.environment');
  }
  if (
    !carvedOut &&
    identity.events.includes('workflow_run') &&
    policy.environments.includes('production')
  ) {
    problems.push('a github-oidc policy that accepts workflow_run cannot grant production');
  }
  const workflowPrefix = `${identity.repository}/.github/workflows/`;
  for (const entry of identity.jobWorkflowRefs) {
    if (!entry.startsWith(workflowPrefix)) {
      problems.push(`job workflow ${entry} is not a workflow file of ${identity.repository}`);
    }
    const ref = entry.slice(entry.indexOf('@') + 1);
    if (!identity.refs.includes(ref)) {
      problems.push(`job workflow ${entry} runs on a ref that identity.refs does not list`);
    }
  }
  if (policy.environments.includes('production')) {
    if (identity.environment === undefined) {
      problems.push('a github-oidc policy that grants production must bind identity.environment');
    }
    const pinnedException = GITHUB_PRODUCTION_REF_EXCEPTIONS.some(
      exception =>
        policy.workload === exception.workload &&
        identity.repository === exception.repository &&
        identity.repositoryId === exception.repositoryId &&
        identity.repositoryOwnerId === exception.repositoryOwnerId &&
        identity.environment === exception.environment &&
        sameList(identity.refs, exception.refs) &&
        sameList(identity.jobWorkflowRefs, exception.jobWorkflowRefs) &&
        sameList(identity.events, exception.events) &&
        sameList(policy.environments, exception.environments) &&
        sameList(policy.secrets, exception.secrets) &&
        policy.audiences.length === 0 &&
        policy.scopes.length === 0 &&
        policy.dynamic.length === 0 &&
        Object.keys(policy.environmentGrants).length === 0
    );
    if (identity.refs.some(ref => ref !== GITHUB_PRODUCTION_REF) && !pinnedException) {
      problems.push(
        `a github-oidc policy that grants production accepts only ${GITHUB_PRODUCTION_REF}`
      );
    }
  }
  if (policy.audiences.length > 0 && identity.environment === undefined) {
    problems.push('a github-oidc policy that grants tokens must bind identity.environment');
  }
  return problems;
}

/**
 * Cross-field checks a single schema cannot express. Returns one message per problem. `registry`
 * is the scope registry the grants are checked against, and `pins` the Cloudflare permission
 * groups and zones deploy grants are checked against; tests pass their own.
 */
export function policyFileProblems(
  policy: Policy,
  registry: StsScopeRegistry = STS_SCOPE_REGISTRY,
  pins: CloudflareDeployPins = CLOUDFLARE_DEPLOY_PINS
): string[] {
  const problems = appliedPolicyProblems(policy, registry, pins);
  for (const [environment, grants] of Object.entries(policy.environmentGrants)) {
    if (grants === undefined) continue;
    if (!policy.environments.some(listed => listed === environment)) {
      problems.push(
        `environmentGrants.${environment} names an environment the policy does not list`
      );
    }
    if (grants.audiences.length + grants.scopes.length + grants.secrets.length === 0) {
      problems.push(`environmentGrants.${environment} grants nothing`);
    }
  }
  // Each environment's policy, with its own grants added, passes every rule the base policy does,
  // so a grant for one environment meets the same registry, reserved-scope and secret-name rules.
  for (const environment of policy.environments) {
    if (policy.environmentGrants[environment] === undefined) continue;
    for (const problem of appliedPolicyProblems(
      effectivePolicy(policy, environment),
      registry,
      pins
    )) {
      if (!problems.includes(problem)) problems.push(`${environment}: ${problem}`);
    }
  }
  return problems;
}

/** The checks of one policy as STS applies it: the base policy, or one environment's. */
function appliedPolicyProblems(
  policy: Policy,
  registry: StsScopeRegistry,
  pins: CloudflareDeployPins
): string[] {
  const problems: string[] = [...grantProblems(policy, registry), ...dynamicProblems(policy, pins)];
  if (hasDuplicates(policy.environments)) problems.push('environments contains a duplicate');
  if (hasDuplicates(policy.secrets)) problems.push('secrets contains a duplicate');
  for (const name of policy.secrets) {
    if (ENVIRONMENT_SUFFIX.test(name)) {
      problems.push(
        `secret ${name} carries an environment suffix; the manager environment picks it`
      );
    }
    if (MINTING_SECRET_NAMES.includes(name)) {
      problems.push(
        `secret ${name} is a minting credential (${MINTING_FOLDER}); no policy may be granted it`
      );
    }
  }
  if (policy.identity.kind === 'github-oidc') {
    problems.push(...githubProblems(policy, policy.identity));
  } else if (policy.workload.startsWith(GITHUB_WORKLOAD_PREFIX)) {
    // The name alone fixes the bundle folder, so a stored bundle can never move between `/ci` and
    // `/workloads` while its workload keeps its name.
    problems.push(`only a github-oidc workload is named ${GITHUB_WORKLOAD_PREFIX}<job>`);
  }
  if (policy.identity.kind === 'vercel-oidc') {
    const sources = policy.identity.environments;
    if (hasDuplicates(sources.map(vercelEnvironmentKey))) {
      problems.push('identity.environments contains a duplicate');
    }
    for (const source of sources) {
      const readable = vercelStsEnvironments(source);
      if (!readable.some(target => policy.environments.includes(target))) {
        problems.push(
          `Vercel environment ${vercelEnvironmentKey(source)} may only read ${readable.join(' or ')}, which the policy does not grant`
        );
      }
    }
    for (const target of policy.environments) {
      if (!sources.some(source => vercelStsEnvironments(source).includes(target))) {
        problems.push(`no listed Vercel environment may read ${target}`);
      }
    }
  }
  return problems;
}
