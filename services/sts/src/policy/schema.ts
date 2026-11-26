import {
  AudienceSchema,
  STS_SCOPE_REGISTRY,
  ScopeSchema,
  SecretNameSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  type StsEnvironment,
  isRegisteredStsScope,
  scopeAudience,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import { z } from 'zod';

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
const JobWorkflowRefSchema = z
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
 * request may have started, so a policy that accepts it accepts nothing else.
 */
export const GITHUB_EVENTS = ['push', 'schedule', 'workflow_dispatch', 'workflow_run'] as const;

/** A production GitHub policy accepts only jobs that run on this ref (design 4.2). */
export const GITHUB_PRODUCTION_REF = 'refs/heads/main';

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
});

export type GithubIdentity = z.infer<typeof GithubIdentitySchema>;

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
 * Dynamic credentials a workload may request (database leases, CI deploy tokens). The enum is
 * empty until those land (decisions Q5): the field fixes the policy shape, and any value fails.
 */
const DynamicGrantSchema = z.never();

export const PolicySchema = z.strictObject({
  workload: WorkloadNameSchema,
  environments: z.array(StsEnvironmentSchema).min(1).max(3),
  identity: PolicyIdentitySchema,
  secrets: z.array(SecretNameSchema).max(256),
  /** Services this workload may mint a token for; empty mints nothing (default deny). */
  audiences: z.array(AudienceSchema.max(63)).max(64).default([]),
  /** Scopes it may hold, each from `STS_SCOPE_REGISTRY` and under one of `audiences`. */
  scopes: z.array(ScopeSchema.max(127)).max(256).default([]),
  dynamic: z.array(DynamicGrantSchema).max(0).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyIdentity = z.infer<typeof PolicyIdentitySchema>;

export const PolicySnapshotEntrySchema = z.strictObject({
  workload: z.string(),
  environments: z.array(z.string()),
  identity: z.string(),
  secrets: z.array(z.string()),
  // A snapshot stored before token grants existed has none.
  audiences: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
});

export const PolicySnapshotSchema = z.array(PolicySnapshotEntrySchema);

/** Token grants: every scope registered and under a listed audience, every audience used. */
function grantProblems(policy: Policy, registry: StsScopeRegistry): string[] {
  const problems: string[] = [];
  if (hasDuplicates(policy.audiences)) problems.push('audiences contains a duplicate');
  if (hasDuplicates(policy.scopes)) problems.push('scopes contains a duplicate');
  for (const scope of policy.scopes) {
    const audience = scopeAudience(scope);
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
    if (audience === policy.workload) {
      problems.push(`audience ${audience} is the workload itself`);
    }
    if (!policy.scopes.some(scope => scopeAudience(scope) === audience)) {
      problems.push(`audience ${audience} has no scope`);
    }
  }
  return problems;
}

const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

function githubProblems(policy: Policy, identity: GithubIdentity): string[] {
  const problems: string[] = [];
  if (!policy.workload.startsWith(GITHUB_WORKLOAD_PREFIX)) {
    problems.push(
      `a github-oidc workload is named ${GITHUB_WORKLOAD_PREFIX}<job>; its bundle folder is /ci/<workload>`
    );
  }
  if (hasDuplicates(identity.refs)) problems.push('identity.refs contains a duplicate');
  if (hasDuplicates(identity.jobWorkflowRefs)) {
    problems.push('identity.jobWorkflowRefs contains a duplicate');
  }
  if (hasDuplicates(identity.events)) problems.push('identity.events contains a duplicate');
  if (identity.events.includes('workflow_run') && identity.events.length > 1) {
    problems.push('a github-oidc policy that accepts workflow_run accepts no other event');
  }
  // A workflow_run job follows a run a pull request may have started; only an environment's
  // protection rules stand between it and the policy's values, in any STS environment.
  if (identity.events.includes('workflow_run') && identity.environment === undefined) {
    problems.push('a github-oidc policy that accepts workflow_run must bind identity.environment');
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
    if (identity.refs.some(ref => ref !== GITHUB_PRODUCTION_REF)) {
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
 * is the scope registry the grants are checked against; tests pass their own.
 */
export function policyFileProblems(
  policy: Policy,
  registry: StsScopeRegistry = STS_SCOPE_REGISTRY
): string[] {
  const problems: string[] = grantProblems(policy, registry);
  if (hasDuplicates(policy.environments)) problems.push('environments contains a duplicate');
  if (hasDuplicates(policy.secrets)) problems.push('secrets contains a duplicate');
  for (const name of policy.secrets) {
    if (ENVIRONMENT_SUFFIX.test(name)) {
      problems.push(
        `secret ${name} carries an environment suffix; the manager environment picks it`
      );
    }
  }
  if (policy.identity.kind === 'github-oidc') {
    problems.push(...githubProblems(policy, policy.identity));
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
