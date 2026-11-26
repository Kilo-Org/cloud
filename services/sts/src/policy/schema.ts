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
const GithubEnvironmentSchema = z.string().min(1).max(255);

/**
 * GitHub events that run with the base repository's privileges on code or input from someone
 * else. A token from one of them is refused unless the policy names the event.
 */
export const GITHUB_PRIVILEGED_EVENTS = [
  'pull_request_target',
  'workflow_run',
  'issue_comment',
] as const;

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
 * GitHub Actions tokens bound to the repository and owner ids. `environments` binds the GitHub
 * environment claim and is required for any policy that grants production; `refs` is an extra
 * filter. https://docs.github.com/en/actions/reference/security/oidc
 */
export const GithubIdentitySchema = z
  .strictObject({
    kind: z.literal('github-oidc'),
    repositoryId: NumericIdSchema,
    repositoryOwnerId: NumericIdSchema,
    environments: z.array(GithubEnvironmentSchema).min(1).max(32).optional(),
    refs: z.array(RefSchema).min(1).max(32).optional(),
    allowedEvents: z.array(z.enum(GITHUB_PRIVILEGED_EVENTS)).min(1).max(3).optional(),
  })
  .refine(identity => identity.environments !== undefined || identity.refs !== undefined, {
    message: 'github-oidc binds environments, refs, or both',
  });

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
    const { refs, environments, allowedEvents } = policy.identity;
    if (refs && hasDuplicates(refs)) problems.push('refs contains a duplicate');
    if (environments && hasDuplicates(environments)) {
      problems.push('identity.environments contains a duplicate');
    }
    if (allowedEvents && hasDuplicates(allowedEvents)) {
      problems.push('allowedEvents contains a duplicate');
    }
    if (policy.environments.includes('production') && environments === undefined) {
      problems.push('a github-oidc policy that grants production must bind identity.environments');
    }
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
