import type {
  PermissionAction,
  PermissionEnforcement,
  PermissionEventDecision,
  PermissionRule,
  PermissionTier,
} from '@/lib/organizations/permissions/types';
import { TIER_RANK, TOOL_LEVEL_PERMISSIONS } from '@/lib/organizations/permissions/types';

export const ENFORCEMENT_OPTIONS = [
  {
    value: 'off',
    label: 'Off',
    description: 'Rules aren’t sent to clients, and no usage is recorded.',
  },
  {
    value: 'shadow',
    label: 'Audit',
    description:
      'Clients record what your rules would decide, but only Kilo and each user’s settings apply.',
  },
  {
    value: 'enforce',
    label: 'Enforce',
    description: 'Clients apply your rules on top of Kilo and each user’s settings.',
  },
] satisfies { value: PermissionEnforcement; label: string; description: string }[];

export const DEFAULT_EFFECT_OPTIONS = [
  {
    value: 'allow',
    label: 'Allow',
    description: 'No organization restriction; Kilo and each user’s settings decide.',
  },
  {
    value: 'ask',
    label: 'Ask',
    description: 'Members are always prompted; they can still deny.',
  },
  {
    value: 'deny',
    label: 'Deny',
    description: 'Blocked, final.',
  },
] satisfies { value: PermissionAction; label: string; description: string }[];

export const TIER_OPTIONS = [
  {
    value: 'broad_allow',
    label: 'Broad allow',
    description:
      'Lifts the default for a tool or command family. Denies and final denies still apply.',
  },
  {
    value: 'specific_deny',
    label: 'Deny',
    description: 'Blocks matching uses. An exception can allow a narrower use.',
  },
  {
    value: 'narrow_allow',
    label: 'Exception',
    description: 'Allows a specific use that a deny would block. Final denies still apply.',
  },
  {
    value: 'final_deny',
    label: 'Final deny',
    description: 'Always blocks matching uses. Nothing overrides it.',
  },
] satisfies { value: PermissionTier; label: string; description: string }[];

export function tierLabel(tier: PermissionTier): string {
  return TIER_OPTIONS.find(option => option.value === tier)?.label ?? tier;
}

export function actionLabel(action: PermissionAction): string {
  return DEFAULT_EFFECT_OPTIONS.find(option => option.value === action)?.label ?? action;
}

export const EVENT_DECISION_OPTIONS = [
  { value: 'allowed', label: 'Allowed' },
  { value: 'asked', label: 'Asked' },
  { value: 'denied', label: 'Denied' },
] satisfies { value: PermissionEventDecision; label: string }[];

export function eventDecisionLabel(decision: PermissionEventDecision): string {
  return EVENT_DECISION_OPTIONS.find(option => option.value === decision)?.label ?? decision;
}

export const KNOWN_PERMISSIONS: readonly string[] = [
  'bash',
  ...TOOL_LEVEL_PERMISSIONS,
  'task',
  'skill',
  'external_directory',
];

type RuleKey = Pick<PermissionRule, 'tier' | 'permission' | 'pattern'>;

export function compareRulesForDisplay(a: RuleKey, b: RuleKey): number {
  return (
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    a.permission.localeCompare(b.permission) ||
    a.pattern.localeCompare(b.pattern)
  );
}

const GIT_READ_ONLY_SUBCOMMANDS = [
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'grep',
];

const GIT_READ_ONLY_FINAL_DENIES = [
  'git -c *',
  'bash -c *',
  'sh -c *',
  'eval *',
  'xargs *',
  'find * -exec *',
  '*>*',
];

export const GIT_READ_ONLY_PRESET: readonly RuleKey[] = [
  ...GIT_READ_ONLY_SUBCOMMANDS.map(subcommand => ({
    tier: 'broad_allow' as const,
    permission: 'bash',
    pattern: `git ${subcommand} *`,
  })),
  ...GIT_READ_ONLY_FINAL_DENIES.map(pattern => ({
    tier: 'final_deny' as const,
    permission: 'bash',
    pattern,
  })),
];

function ruleKey(rule: RuleKey): string {
  return `${rule.tier}\u0000${rule.permission}\u0000${rule.pattern}`;
}

export function planPreset(
  preset: readonly RuleKey[],
  existing: readonly RuleKey[]
): { toAdd: RuleKey[]; skipped: RuleKey[] } {
  const existingKeys = new Set(existing.map(ruleKey));
  const toAdd: RuleKey[] = [];
  const skipped: RuleKey[] = [];
  for (const rule of preset) {
    (existingKeys.has(ruleKey(rule)) ? skipped : toAdd).push(rule);
  }
  return { toAdd, skipped };
}

export function presetResultMessage(result: {
  added: number;
  skipped: number;
  failed: number;
}): string {
  const parts = [`Added ${result.added} ${result.added === 1 ? 'rule' : 'rules'}`];
  if (result.skipped > 0) parts.push(`skipped ${result.skipped} that already exist`);
  if (result.failed > 0) parts.push(`${result.failed} couldn’t be added`);
  return `${parts.join(', ')}.`;
}
