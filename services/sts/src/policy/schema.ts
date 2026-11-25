import {
  SecretNameSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
} from '@kilocode/sts-contracts';
import { z } from 'zod';

const TeamSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const RefSchema = z.string().regex(/^refs\/[A-Za-z0-9._/-]{1,200}$/);
const IdentifierSchema = z.string().min(1).max(64);
const EnvironmentValueSchema = z.string().min(1).max(64);

export const WorkerBindingIdentitySchema = z.strictObject({
  kind: z.literal('worker-binding'),
});

export const VercelIdentitySchema = z.strictObject({
  kind: z.literal('vercel-oidc'),
  teamSlug: TeamSlugSchema,
  projectId: IdentifierSchema,
  vercelEnvironments: z.array(EnvironmentValueSchema).min(1).max(16),
});

export const FlyIdentitySchema = z.strictObject({
  kind: z.literal('fly-oidc'),
  org: TeamSlugSchema,
  app: TeamSlugSchema,
});

export const GithubIdentitySchema = z
  .strictObject({
    kind: z.literal('github-oidc'),
    repositoryId: z.string().regex(/^[0-9]{1,20}$/),
    repositoryOwnerId: z.string().regex(/^[0-9]{1,20}$/),
    refs: z.array(RefSchema).min(1).max(32).optional(),
    environments: z.array(EnvironmentValueSchema).min(1).max(32).optional(),
  })
  .refine(identity => (identity.refs === undefined) !== (identity.environments === undefined), {
    message: 'github-oidc requires exactly one of refs or environments',
  });

export const PolicyIdentitySchema = z.discriminatedUnion('kind', [
  WorkerBindingIdentitySchema,
  VercelIdentitySchema,
  FlyIdentitySchema,
  GithubIdentitySchema,
]);

function hasDuplicates(values: string[]): boolean {
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

const ENVIRONMENT_SUFFIX = /_(PROD|STAGING|DEV|DEVELOPMENT)$/;

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
  if (policy.identity.kind === 'vercel-oidc' && hasDuplicates(policy.identity.vercelEnvironments)) {
    problems.push('vercelEnvironments contains a duplicate');
  }
  if (policy.identity.kind === 'github-oidc') {
    const { refs, environments } = policy.identity;
    if (refs && hasDuplicates(refs)) problems.push('refs contains a duplicate');
    if (environments && hasDuplicates(environments)) {
      problems.push('environments contains a duplicate');
    }
  }
  return problems;
}
