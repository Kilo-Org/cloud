import {
  SecretNameSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  type StsEnvironment,
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

/** Vercel's built-in environments; any other `environment` claim is a custom environment's slug. */
const VERCEL_STANDARD_ENVIRONMENTS = ['production', 'preview', 'development'] as const;

const VercelEnvironmentSchema = z.union([
  z.enum(VERCEL_STANDARD_ENVIRONMENTS),
  z.strictObject({ customEnvironmentId: StableIdSchema }),
]);

export type VercelEnvironment = z.infer<typeof VercelEnvironmentSchema>;

export const VERCEL_ISSUER_PREFIX = 'https://oidc.vercel.com/';
const VercelTeamIdSchema = z.string().regex(/^team_[A-Za-z0-9]{1,64}$/);

/**
 * Vercel function tokens after the custom-audience exchange (https://vercel.com/docs/oidc/reference).
 * `issuer` is the team issuer an exchanged token carries, written out in full: Vercel documents
 * `https://oidc.vercel.com/<team slug>`, and its Sandbox tokens carry the team id form instead, so
 * the policy names one of the two and the README's proof run says which. The stable `owner_id`,
 * `project_id` and `environment` (or `custom_environment_id`) claims bind the identity;
 * `projectName` is for people reading the policy and never authorizes.
 */
export const VercelIdentitySchema = z
  .strictObject({
    kind: z.literal('vercel-oidc'),
    issuer: z.string(),
    teamSlug: SlugSchema,
    teamId: VercelTeamIdSchema,
    projectId: z.string().regex(/^prj_[A-Za-z0-9]{1,64}$/),
    projectName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    environments: z.array(VercelEnvironmentSchema).min(1).max(32),
  })
  .refine(
    identity =>
      identity.issuer === `${VERCEL_ISSUER_PREFIX}${identity.teamSlug}` ||
      identity.issuer === `${VERCEL_ISSUER_PREFIX}${identity.teamId}`,
    { message: 'vercel-oidc issuer is https://oidc.vercel.com/<teamSlug> or /<teamId>' }
  );

/**
 * The STS environments a Vercel environment may read (design 6.2): only `production` reaches
 * production values; a preview runs code from any branch, so it and `development` read development
 * values; a custom environment reads staging or development values.
 */
export function vercelStsEnvironments(environment: VercelEnvironment): readonly StsEnvironment[] {
  if (typeof environment !== 'string') return ['staging', 'development'];
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

export const PolicySchema = z.strictObject({
  workload: WorkloadNameSchema,
  environments: z.array(StsEnvironmentSchema).min(1).max(3),
  identity: PolicyIdentitySchema,
  secrets: z.array(SecretNameSchema).max(256),
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyIdentity = z.infer<typeof PolicyIdentitySchema>;

export const PolicySnapshotEntrySchema = z.strictObject({
  workload: z.string(),
  environments: z.array(z.string()),
  identity: z.string(),
  secrets: z.array(z.string()),
});

export const PolicySnapshotSchema = z.array(PolicySnapshotEntrySchema);

const ENVIRONMENT_SUFFIX = /_(PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT)$/;

/** Cross-field checks a single schema cannot express. Returns one message per problem. */
export function policyFileProblems(policy: Policy): string[] {
  const problems: string[] = [];
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
