import {
  UTS_CI_TOKEN_MAX_LIFETIME_SECONDS,
  UtsScopeSchema,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env } from '../env';
import type { ScopeRegistry } from '../scopes/policy';

/**
 * CI trust policies (design 5.3, 6.2, 6.3): which GitHub Actions jobs may exchange their OIDC
 * token at `/token`, for which one UTS account, which scopes and how long. They live in the Worker
 * var `CI_TOKEN_POLICIES`, a JSON array per environment in `wrangler.jsonc`, so a change is a
 * reviewed config change. An absent var or an empty array turns the exchange off, and a var that
 * fails any rule below also keeps it off and logs the problems by rule, never by value.
 *
 * A policy binds the stable repository and owner ids and builds the exact immutable-format subject
 * `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:<environment>` from its fields, as STS does.
 * The token's `environment` and `job_workflow_ref` pick one policy; that policy's subject, `ref`
 * and `event_name` must then match, and the matched workflow entry must be pinned to the token's
 * own `ref`, so a run on one listed ref that calls a workflow pinned to another is refused.
 *
 * Load rules, each failing the whole var:
 * - names are unique and `ci-<job>`; at most one policy per repository id, GitHub environment and
 *   workflow file;
 * - every workflow entry is a workflow file of the policy's repository, on a listed ref;
 * - `events` is an allowlist of `push`, `schedule`, `workflow_dispatch` and `workflow_run`, so no
 *   event a fork author can start can be listed; `workflow_run` stands alone and never in
 *   production, because GitHub gives such a job the default branch even after a fork's run;
 * - in production, `refs` is exactly `refs/heads/main`;
 * - `legacySubject` (GitHub's default subject, still bound to the ids) only for Kilo-Org/kilocode,
 *   which cannot switch to immutable subjects yet (design 6.2, Q62a);
 * - every scope is registered, PAT-eligible and needs no organization claim. A PAT carries such a
 *   scope for up to a year, so a 1-hour CI token with it holds no more than a PAT can; this keeps
 *   privileged, step-up, session-bound, staff and credential-changing scopes out of CI.
 */

/** The events a policy may list; every event a fork author can start is missing. */
export const CI_EVENTS = ['push', 'schedule', 'workflow_dispatch', 'workflow_run'] as const;

/** A production policy accepts only jobs that run on this ref. */
export const CI_PRODUCTION_REF = 'refs/heads/main';

/**
 * The one repository whose policies may set `legacySubject` (design 6.2, decision Q62a). Its jobs
 * still carry GitHub's default subject, because npm trusted publishing fails for repositories that
 * use immutable subjects (npm/cli#9969). The repository and owner id claims still have to match,
 * and every other binding applies, so a renamed or recreated repository with the same name is
 * refused. When kilocode switches to immutable subjects, delete this constant, the field and its
 * load rule.
 */
export const CI_LEGACY_SUBJECT_REPOSITORY = {
  repository: 'Kilo-Org/kilocode',
  repositoryId: '946087422',
  repositoryOwnerId: '201822503',
} as const;

const NumericIdSchema = z.string().regex(/^[0-9]{1,20}$/);
const RefSchema = z.string().regex(/^refs\/[A-Za-z0-9._/-]{1,200}$/);
/** GitHub's own limits: an owner name of up to 39 characters, a repository name of up to 100. */
const RepositorySchema = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
/** Plain names only, so the token's `sub` carries the name as written, with nothing escaped. */
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,255}$/);
/** At most 512 characters, so the audit row can record the matched entry as one attribute. */
const JobWorkflowRefSchema = z
  .string()
  .max(512)
  .regex(
    /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[A-Za-z0-9._-]{1,200}\.ya?ml@refs\/[A-Za-z0-9._/-]{1,200}$/
  );

export const CiPolicySchema = z.strictObject({
  /** The policy's name: the issued token's `client_id` and the audit rows' `policy`. */
  name: z.string().regex(/^ci-[a-z0-9][a-z0-9-]{0,60}$/),
  repository: RepositorySchema,
  repositoryId: NumericIdSchema,
  repositoryOwnerId: NumericIdSchema,
  /** The one GitHub environment whose jobs the policy trusts. */
  environment: EnvironmentNameSchema,
  refs: z.array(RefSchema).min(1).max(8),
  jobWorkflowRefs: z.array(JobWorkflowRefSchema).min(1).max(8),
  events: z.array(z.enum(CI_EVENTS)).min(1).max(CI_EVENTS.length),
  legacySubject: z.literal(true).optional(),
  /** The one UTS account every token of the policy names in `sub`: a dedicated CI account. */
  subject: z.string().min(1).max(255),
  scopes: z.array(UtsScopeSchema).min(1).max(8),
  lifetimeSeconds: z.number().int().min(60).max(UTS_CI_TOKEN_MAX_LIFETIME_SECONDS),
});
export type CiPolicy = z.infer<typeof CiPolicySchema>;

const CiPoliciesSchema = z.array(CiPolicySchema).max(64);

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** The workflow file of a `job_workflow_ref`: everything before its `@<ref>`. */
export function workflowFile(jobWorkflowRef: string): string {
  return jobWorkflowRef.slice(0, jobWorkflowRef.indexOf('@'));
}

/** The rules one policy breaks, each as a message that names no value. */
function policyProblems(
  policy: CiPolicy,
  environment: UtsEnvironment,
  scopes: ScopeRegistry
): string[] {
  const problems: string[] = [];
  const at = `policy ${policy.name}`;
  if (hasDuplicates(policy.refs)) problems.push(`${at}: refs contains a duplicate`);
  if (hasDuplicates(policy.jobWorkflowRefs)) {
    problems.push(`${at}: jobWorkflowRefs contains a duplicate`);
  }
  if (hasDuplicates(policy.events)) problems.push(`${at}: events contains a duplicate`);
  if (hasDuplicates(policy.scopes)) problems.push(`${at}: scopes contains a duplicate`);
  for (const entry of policy.jobWorkflowRefs) {
    if (!entry.startsWith(`${policy.repository}/.github/workflows/`)) {
      problems.push(`${at}: a job workflow is not a workflow file of the repository`);
    }
    if (!policy.refs.includes(entry.slice(entry.indexOf('@') + 1))) {
      problems.push(`${at}: a job workflow runs on a ref that refs does not list`);
    }
  }
  if (policy.events.includes('workflow_run') && policy.events.length > 1) {
    problems.push(`${at}: a policy that accepts workflow_run accepts no other event`);
  }
  if (environment === 'production') {
    if (policy.events.includes('workflow_run')) {
      problems.push(`${at}: a production policy cannot accept workflow_run`);
    }
    if (policy.refs.some(ref => ref !== CI_PRODUCTION_REF)) {
      problems.push(`${at}: a production policy accepts only ${CI_PRODUCTION_REF}`);
    }
  }
  if (
    policy.legacySubject === true &&
    (policy.repository !== CI_LEGACY_SUBJECT_REPOSITORY.repository ||
      policy.repositoryId !== CI_LEGACY_SUBJECT_REPOSITORY.repositoryId ||
      policy.repositoryOwnerId !== CI_LEGACY_SUBJECT_REPOSITORY.repositoryOwnerId)
  ) {
    problems.push(`${at}: legacySubject is allowed only for Kilo-Org/kilocode`);
  }
  for (const scope of policy.scopes) {
    const entry = scopes(scope);
    if (entry === null) {
      problems.push(`${at}: a scope is not registered`);
    } else if (!entry.patEligible || entry.requiresOrgClaim || entry.issuance !== 'grant') {
      problems.push(`${at}: a scope is not PAT-eligible, or needs an organization claim`);
    }
  }
  return problems;
}

/** The problems of a whole policy list in `environment`: each policy's, then the cross checks. */
export function ciPolicyProblems(
  policies: readonly CiPolicy[],
  environment: UtsEnvironment,
  scopes: ScopeRegistry
): string[] {
  const problems = policies.flatMap(policy => policyProblems(policy, environment, scopes));
  if (hasDuplicates(policies.map(policy => policy.name))) {
    problems.push('two policies share a name');
  }
  const selectors = policies.flatMap(policy =>
    policy.jobWorkflowRefs.map(
      entry => `${policy.repositoryId}\u0000${policy.environment}\u0000${workflowFile(entry)}`
    )
  );
  if (hasDuplicates(selectors)) {
    problems.push('two policies share a repository, GitHub environment and workflow file');
  }
  return problems;
}

/**
 * The CI exchange as the environment configures it: `off` without policies, `misconfigured` when
 * the var breaks a rule (the exchange then stays off), `on` with the validated policies.
 */
export type CiPolicies =
  | { status: 'off' }
  | { status: 'misconfigured'; problems: string[] }
  | { status: 'on'; policies: readonly CiPolicy[] };

/** Validates `CI_TOKEN_POLICIES` for `environment`, whose scope registry is `scopes`. */
export function ciPolicies(
  env: Pick<Env, 'CI_TOKEN_POLICIES'>,
  environment: UtsEnvironment,
  scopes: ScopeRegistry
): CiPolicies {
  const raw = env.CI_TOKEN_POLICIES;
  if (raw === undefined || raw.trim() === '') return { status: 'off' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 'misconfigured', problems: ['CI_TOKEN_POLICIES is not JSON'] };
  }
  const parsed = CiPoliciesSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'misconfigured',
      problems: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code}`),
    };
  }
  if (parsed.data.length === 0) return { status: 'off' };
  const problems = ciPolicyProblems(parsed.data, environment, scopes);
  return problems.length === 0
    ? { status: 'on', policies: parsed.data }
    : { status: 'misconfigured', problems };
}

/**
 * The `sub` a job of `policy` must carry: GitHub's immutable format, which names the owner and
 * repository ids next to the names, for the policy's environment.
 */
export function ciSubject(policy: CiPolicy): string {
  const [owner, name] = policy.repository.split('/');
  return `repo:${owner}@${policy.repositoryOwnerId}/${name}@${policy.repositoryId}:environment:${policy.environment}`;
}

/** GitHub's default subject, accepted only for a `legacySubject` policy. */
export function ciLegacySubject(policy: CiPolicy): string {
  return `repo:${policy.repository}:environment:${policy.environment}`;
}
