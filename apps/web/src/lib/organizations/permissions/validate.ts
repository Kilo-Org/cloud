import {
  isToolLevelPermission,
  MAX_DESCRIPTION_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_PERMISSION_LENGTH,
  tierAction,
  type PermissionTier,
} from './types';

export type PermissionRuleCandidate = {
  tier: PermissionTier;
  permission: string;
  pattern: string;
  description?: string | null;
};

export type PermissionRuleValidation = { errors: string[]; warnings: string[] };

const BROAD_ALLOW_PATTERNS = new Set(['*', '* *', '**']);

export function validatePermissionRule(rule: PermissionRuleCandidate): PermissionRuleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const permission = rule.permission.trim();

  if (permission.length === 0) errors.push('Permission is required.');
  if (permission.length > MAX_PERMISSION_LENGTH) {
    errors.push(`Permission must be at most ${MAX_PERMISSION_LENGTH} characters.`);
  }
  if (rule.pattern.length === 0) errors.push('Pattern is required.');
  if (rule.pattern.length > MAX_PATTERN_LENGTH) {
    errors.push(`Pattern must be at most ${MAX_PATTERN_LENGTH} characters.`);
  }
  if ((rule.description ?? '').length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (isToolLevelPermission(permission) && rule.pattern !== '*') {
    errors.push(`"${permission}" is checked per tool call, so its pattern must be "*".`);
  }
  const allows = tierAction(rule.tier) === 'allow';
  if (allows && permission === '*') {
    errors.push('An allow rule cannot apply to every permission. Name a specific permission.');
  }
  if (rule.tier === 'narrow_allow' && !isToolLevelPermission(permission)) {
    if (BROAD_ALLOW_PATTERNS.has(rule.pattern.trim())) {
      warnings.push(
        'This narrow allow matches every command and cancels all specific denies for it.'
      );
    } else if (/^[^\s*?]+ \*$/.test(rule.pattern.trim())) {
      warnings.push(
        'This narrow allow matches every subcommand of one program and may cancel specific denies beneath it.'
      );
    }
  }
  return { errors, warnings };
}
