import { SecuritySeverity } from '@kilocode/db/schema-types';

export const SECURITY_SEVERITIES = [
  SecuritySeverity.CRITICAL,
  SecuritySeverity.HIGH,
  SecuritySeverity.MEDIUM,
  SecuritySeverity.LOW,
] as const;

export type SecuritySeverityRank = 0 | 1 | 2 | 3;

export const LOWEST_SECURITY_SEVERITY_RANK: SecuritySeverityRank = 3;

export const SECURITY_SEVERITY_RANKS = {
  [SecuritySeverity.CRITICAL]: 0,
  [SecuritySeverity.HIGH]: 1,
  [SecuritySeverity.MEDIUM]: 2,
  [SecuritySeverity.LOW]: LOWEST_SECURITY_SEVERITY_RANK,
} as const satisfies Record<SecuritySeverity, SecuritySeverityRank>;

export function isSecuritySeverity(value: string): value is SecuritySeverity {
  return SECURITY_SEVERITIES.includes(value as SecuritySeverity);
}

export function getSecuritySeverityRank(severity: string | null): SecuritySeverityRank | null {
  if (!severity || !isSecuritySeverity(severity)) return null;
  return SECURITY_SEVERITY_RANKS[severity];
}

export type SecuritySeverityThreshold = SecuritySeverity | 'all';

export function getSecuritySeverityThresholdRank(
  threshold: SecuritySeverityThreshold
): SecuritySeverityRank {
  return threshold === 'all' ? LOWEST_SECURITY_SEVERITY_RANK : SECURITY_SEVERITY_RANKS[threshold];
}
