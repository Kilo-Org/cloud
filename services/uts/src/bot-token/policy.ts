import {
  UTS_ACCOUNT_AUDIENCE,
  UTS_BOT_TOKEN_MAX_LIFETIME_SECONDS,
  UTS_CREDENTIAL_SCOPES,
  UtsBotAccountSchema,
  UtsScopeSchema,
  type UtsScopeEntry,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env } from '../env';
import type { ScopeRegistry } from '../scopes/policy';

/**
 * Bot-token policies (design 5.3, 6.5): which STS workload may mint tokens for which internal bot
 * account, in which organization, with which scopes and for how long. They live in the Worker var
 * `BOT_TOKEN_POLICIES`, a JSON array per environment in `wrangler.jsonc`, so a change is a
 * reviewed config change. An absent var or an empty array turns the mint off, and a var that
 * fails any rule below also keeps it off and logs the problems by rule, never by value. The
 * workloads the policies name are the mint's whole caller allow-list.
 *
 * Load rules, each failing the whole var:
 * - at most one policy per workload and bot account;
 * - every scope is registered, minted from a grant (not only by the broker exchange), needs no
 *   session (a bot token has no `sid`), needs no step-up, is not privileged, changes no
 *   credential, belongs to no staff list and is not a UTS account API scope.
 */

/** An STS workload name, as STS policy files spell it. */
const WorkloadSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const BotTokenPolicySchema = z.strictObject({
  /** The calling workload: the STS token's `client_id`, and the bot token's `client_id` and `req`. */
  workload: WorkloadSchema,
  /** The internal bot account every token of the policy names in `sub`. */
  account: UtsBotAccountSchema,
  /** The organization the bot acts in: the token's `org`, checked against its membership. */
  org: z.uuid(),
  scopes: z.array(UtsScopeSchema).min(1).max(8),
  lifetimeSeconds: z.number().int().min(60).max(UTS_BOT_TOKEN_MAX_LIFETIME_SECONDS),
});
export type BotTokenPolicy = z.infer<typeof BotTokenPolicySchema>;

const BotTokenPoliciesSchema = z.array(BotTokenPolicySchema).max(64);

/** The problems of a whole policy list, each as a message that names no value. */
function botTokenPolicyProblems(
  policies: readonly BotTokenPolicy[],
  scopes: ScopeRegistry
): string[] {
  const problems: string[] = [];
  for (const policy of policies) {
    const at = `policy ${policy.workload} ${policy.account}`;
    if (new Set(policy.scopes).size !== policy.scopes.length) {
      problems.push(`${at}: scopes contains a duplicate`);
    }
    for (const scope of policy.scopes) {
      const entry = scopes(scope);
      if (entry === null) {
        problems.push(`${at}: a scope is not registered`);
      } else if (
        UTS_CREDENTIAL_SCOPES.includes(scope) ||
        entry.issuance !== 'grant' ||
        entry.requiresSession ||
        entry.stepUp ||
        entry.privileged ||
        entry.subjects.kind === 'staff' ||
        entry.audience === UTS_ACCOUNT_AUDIENCE
      ) {
        problems.push(`${at}: a scope is session-bound, privileged, staff-only or a UTS scope`);
      }
    }
  }
  const pairs = new Set(policies.map(policy => `${policy.workload}\u0000${policy.account}`));
  if (pairs.size !== policies.length) {
    problems.push('two policies share a workload and bot account');
  }
  return problems;
}

/**
 * The mint as the environment configures it: `off` without policies, `misconfigured` when the
 * var breaks a rule (the mint then stays off), `on` with the validated policies.
 */
export type BotTokenPolicies =
  | { status: 'off' }
  | { status: 'misconfigured'; problems: string[] }
  | { status: 'on'; policies: readonly BotTokenPolicy[] };

/** Validates `BOT_TOKEN_POLICIES` against the scope registry `scopes`. */
export function botTokenPolicies(
  env: Pick<Env, 'BOT_TOKEN_POLICIES'>,
  scopes: ScopeRegistry
): BotTokenPolicies {
  const raw = env.BOT_TOKEN_POLICIES;
  if (raw === undefined || raw.trim() === '') return { status: 'off' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 'misconfigured', problems: ['BOT_TOKEN_POLICIES is not JSON'] };
  }
  const parsed = BotTokenPoliciesSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'misconfigured',
      problems: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code}`),
    };
  }
  if (parsed.data.length === 0) return { status: 'off' };
  const problems = botTokenPolicyProblems(parsed.data, scopes);
  return problems.length === 0
    ? { status: 'on', policies: parsed.data }
    : { status: 'misconfigured', problems };
}

/**
 * How long a token of `policy` for a scope with `entry` lives. A PAT-eligible scope may live the
 * policy's lifetime, since a PAT carries it far longer; any other scope keeps its registered
 * maximum (10 minutes or less).
 */
export function botTokenLifetimeSeconds(policy: BotTokenPolicy, entry: UtsScopeEntry): number {
  return entry.patEligible
    ? policy.lifetimeSeconds
    : Math.min(policy.lifetimeSeconds, entry.maxLifetimeSeconds);
}
