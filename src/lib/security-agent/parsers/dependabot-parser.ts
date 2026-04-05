/**
 * Security Reviews - Dependabot Parser
 *
 * Parse Dependabot alerts from GitHub API into our internal format.
 */

import {
  SecurityFindingSource,
  SecurityFindingStatus,
  mapDependabotStateToStatus,
  type DependabotAlertRaw,
  type ParsedSecurityFinding,
} from '../core/types';

/**
 * Parse a single Dependabot alert into our internal format
 */
export function parseDependabotAlert(
  alert: DependabotAlertRaw,
  _repoFullName: string
): ParsedSecurityFinding {
  const status = mapDependabotStateToStatus(alert.state);

  // Get ignored reason if dismissed
  let ignoredReason: string | null = null;
  let ignoredBy: string | null = null;

  if (status === SecurityFindingStatus.IGNORED) {
    ignoredReason = alert.dismissed_reason || null;
    ignoredBy = alert.dismissed_by?.login || null;
  }

  // Extract CWE IDs from the advisory
  const cweIds = alert.security_advisory.cwes?.map(cwe => cwe.cwe_id) || null;

  // Extract CVSS score from the advisory
  const cvssScore = alert.security_advisory.cvss?.score || null;

  // Extract dependency scope
  const dependencyScope = alert.dependency.scope || null;

  return {
    source: SecurityFindingSource.DEPENDABOT,
    source_id: alert.number.toString(),
    severity: alert.security_advisory.severity,
    ghsa_id: alert.security_advisory.ghsa_id,
    cve_id: alert.security_advisory.cve_id,
    package_name: alert.dependency.package.name,
    package_ecosystem: alert.dependency.package.ecosystem,
    vulnerable_version_range: alert.security_vulnerability.vulnerable_version_range,
    patched_version: alert.security_vulnerability.first_patched_version?.identifier || null,
    manifest_path: alert.dependency.manifest_path,
    title: alert.security_advisory.summary,
    description: alert.security_advisory.description,
    status,
    ignored_reason: ignoredReason,
    ignored_by: ignoredBy,
    fixed_at: alert.fixed_at,
    dependabot_html_url: alert.html_url,
    first_detected_at: alert.created_at,
    raw_data: alert,
    // Additional metadata (denormalized for queries)
    cwe_ids: cweIds,
    cvss_score: cvssScore,
    dependency_scope: dependencyScope,
  };
}

/**
 * Parse multiple Dependabot alerts
 */
export function parseDependabotAlerts(
  alerts: DependabotAlertRaw[],
  repoFullName: string
): ParsedSecurityFinding[] {
  return alerts.map(alert => parseDependabotAlert(alert, repoFullName));
}

/**
 * Get summary statistics from parsed findings
 */
export function getAlertsSummary(findings: ParsedSecurityFinding[]): {
  total: number;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
} {
  const bySeverity: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  const byStatus: Record<string, number> = {
    open: 0,
    fixed: 0,
    ignored: 0,
  };

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byStatus[finding.status] = (byStatus[finding.status] || 0) + 1;
  }

  return {
    total: findings.length,
    bySeverity,
    byStatus,
  };
}
