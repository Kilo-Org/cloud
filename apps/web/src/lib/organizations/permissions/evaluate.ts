import { matchesGlob } from './match';
import { stricter } from './merge';
import {
  TIER_RANK,
  tierAction,
  type PermissionAction,
  type PermissionPolicy,
  type PermissionTier,
} from './types';

export type PermissionRequest = { permission: string; pattern: string };

export type OrgDecision = {
  decision: PermissionAction;
  ruleId?: string;
  tier?: PermissionTier;
};

export function evaluateOrgDecision(
  policy: Pick<PermissionPolicy, 'defaultEffect' | 'rules'>,
  request: PermissionRequest
): OrgDecision {
  let best: PermissionPolicy['rules'][number] | undefined;
  for (const rule of policy.rules) {
    if (best && TIER_RANK[rule.tier] <= TIER_RANK[best.tier]) continue;
    if (!matchesGlob(request.permission, rule.permission)) continue;
    if (!matchesGlob(request.pattern, rule.pattern)) continue;
    best = rule;
  }
  if (!best) return { decision: policy.defaultEffect };
  return {
    decision: tierAction(best.tier),
    tier: best.tier,
    ...(best.id === undefined ? {} : { ruleId: best.id }),
  };
}

/** One decision for a tool call with several patterns: the strictest per-pattern decision wins. */
export function evaluateOrgDecisionForPatterns(
  policy: Pick<PermissionPolicy, 'defaultEffect' | 'rules'>,
  permission: string,
  patterns: readonly string[]
): OrgDecision {
  if (patterns.length === 0) return { decision: policy.defaultEffect };
  let result: OrgDecision | undefined;
  for (const pattern of patterns) {
    const next = evaluateOrgDecision(policy, { permission, pattern });
    if (!result || stricter(next.decision, result.decision) !== result.decision) result = next;
  }
  return result ?? { decision: policy.defaultEffect };
}

/**
 * The reference client result. In `shadow` and `off` modes the org decision is reported (shadow
 * only) but never applied.
 */
export function finalClientDecision(
  policy: PermissionPolicy,
  orgDecision: PermissionAction,
  localResult: PermissionAction
): PermissionAction {
  return policy.enforcement === 'enforce' ? stricter(orgDecision, localResult) : localResult;
}
