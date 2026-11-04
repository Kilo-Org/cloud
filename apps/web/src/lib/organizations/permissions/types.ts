import * as z from 'zod';
import {
  MAX_ORGANIZATION_PERMISSION_DESCRIPTION_LENGTH,
  MAX_ORGANIZATION_PERMISSION_LENGTH,
  MAX_ORGANIZATION_PERMISSION_PATTERN_LENGTH,
  ORGANIZATION_PERMISSION_DEFAULT_EFFECTS,
  ORGANIZATION_PERMISSION_EVENT_DECISIONS,
  ORGANIZATION_PERMISSION_TIERS,
  ORGANIZATION_TOOL_LEVEL_PERMISSIONS,
  ORGANIZATION_GUARDRAIL_ENFORCEMENT_MODES,
} from '@kilocode/db/schema-types';

export const PERMISSION_TIERS = ORGANIZATION_PERMISSION_TIERS;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];
export const PermissionTierSchema = z.enum(PERMISSION_TIERS);

export const PERMISSION_ACTIONS = ORGANIZATION_PERMISSION_DEFAULT_EFFECTS;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export const PermissionActionSchema = z.enum(PERMISSION_ACTIONS);

export const PERMISSION_ENFORCEMENTS = ORGANIZATION_GUARDRAIL_ENFORCEMENT_MODES;
export type PermissionEnforcement = (typeof PERMISSION_ENFORCEMENTS)[number];
export const PermissionEnforcementSchema = z.enum(PERMISSION_ENFORCEMENTS);

export const PERMISSION_EVENT_DECISIONS = ORGANIZATION_PERMISSION_EVENT_DECISIONS;
export type PermissionEventDecision = (typeof PERMISSION_EVENT_DECISIONS)[number];

export const PERMISSION_MATCH_ALGORITHM = 'glob-v1';

/**
 * Permissions the Kilo CLI checks once per tool call. Their rules must use pattern `*`. Shared
 * by the database CHECK constraint, rule validation, and the admin UI.
 */
export const TOOL_LEVEL_PERMISSIONS = ORGANIZATION_TOOL_LEVEL_PERMISSIONS;
export type ToolLevelPermission = (typeof TOOL_LEVEL_PERMISSIONS)[number];

export function isToolLevelPermission(permission: string): boolean {
  return (TOOL_LEVEL_PERMISSIONS as readonly string[]).includes(permission);
}

export const TIER_RANK: Record<PermissionTier, number> = {
  broad_allow: 1,
  specific_deny: 2,
  narrow_allow: 3,
  final_deny: 4,
};

export function tierAction(tier: PermissionTier): 'allow' | 'deny' {
  return tier === 'broad_allow' || tier === 'narrow_allow' ? 'allow' : 'deny';
}

export const MAX_PERMISSION_LENGTH = MAX_ORGANIZATION_PERMISSION_LENGTH;
export const MAX_PATTERN_LENGTH = MAX_ORGANIZATION_PERMISSION_PATTERN_LENGTH;
export const MAX_DESCRIPTION_LENGTH = MAX_ORGANIZATION_PERMISSION_DESCRIPTION_LENGTH;
export const MAX_ORGANIZATION_PERMISSION_RULES = 500;
export const MAX_COMMAND_KEY_LENGTH = 200;
export const MAX_PERMISSION_EVENTS_PER_REQUEST = 200;
export const MAX_PERMISSION_EVENT_COUNT = 100_000;

export const PermissionRuleScopeSchema = z.object({ type: z.literal('organization') });
export type PermissionRuleScope = z.infer<typeof PermissionRuleScopeSchema>;

export type PermissionRule = {
  id?: string;
  tier: PermissionTier;
  permission: string;
  pattern: string;
};

export type PermissionPolicy = {
  enforcement: PermissionEnforcement;
  defaultEffect: PermissionAction;
  rules: readonly PermissionRule[];
};

export const PermissionRuleInputSchema = z.object({
  tier: PermissionTierSchema,
  permission: z.string().trim().min(1).max(MAX_PERMISSION_LENGTH),
  pattern: z
    .string()
    .min(1)
    .max(MAX_PATTERN_LENGTH)
    .refine(value => value === value.trim(), 'Pattern must not start or end with whitespace'),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).nullish(),
});
export type PermissionRuleInput = z.infer<typeof PermissionRuleInputSchema>;

export const PermissionPolicyRuleSchema = z.object({
  id: z.string(),
  tier: PermissionTierSchema,
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(['allow', 'deny']),
  scope: PermissionRuleScopeSchema,
  description: z.string().nullable(),
});
export type PermissionPolicyRule = z.infer<typeof PermissionPolicyRuleSchema>;

export const PermissionPolicyResponseSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int(),
  enforcement: PermissionEnforcementSchema,
  defaultEffect: PermissionActionSchema,
  evaluation: z.object({
    tiers: z.array(PermissionTierSchema),
    match: z.literal(PERMISSION_MATCH_ALGORITHM),
  }),
  rules: z.array(PermissionPolicyRuleSchema),
});
export type PermissionPolicyResponse = z.infer<typeof PermissionPolicyResponseSchema>;

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tier rank, then code-point order of `permission` and `pattern`, so every client sees one order. */
export function comparePermissionRules(
  a: Pick<PermissionRule, 'tier' | 'permission' | 'pattern'>,
  b: Pick<PermissionRule, 'tier' | 'permission' | 'pattern'>
): number {
  return (
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    compareCodePoints(a.permission, b.permission) ||
    compareCodePoints(a.pattern, b.pattern)
  );
}
