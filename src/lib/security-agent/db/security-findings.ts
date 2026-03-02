/**
 * Security Findings - Database Operations
 *
 * Database operations for security findings.
 * Follows Drizzle ORM patterns used throughout the codebase.
 */

import { db } from '@/lib/drizzle';
import { security_findings } from '@kilocode/db/schema';
import { eq, and, desc, count, sql, max, or } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { SecurityFinding, NewSecurityFinding } from '@kilocode/db/schema';
import type {
  SecurityReviewOwner,
  SecurityFindingStatus,
  SecuritySeverity,
  ParsedSecurityFinding,
} from '../core/types';

type SecurityFindingStatusFilter = SecurityFindingStatus | 'closed';

/**
 * Owner type for database queries
 */
type Owner = { type: 'org'; id: string } | { type: 'user'; id: string };

/**
 * Convert SecurityReviewOwner to Owner format used in queries
 */
function toOwner(owner: SecurityReviewOwner): Owner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

/**
 * Parameters for creating a security finding
 */
type CreateFindingParams = ParsedSecurityFinding & {
  owner: SecurityReviewOwner;
  platformIntegrationId?: string;
  repoFullName: string;
  slaDueAt?: Date;
};

/**
 * Creates a new security finding
 */
export async function createSecurityFinding(params: CreateFindingParams): Promise<string> {
  try {
    const owner = toOwner(params.owner);

    const [finding] = await db
      .insert(security_findings)
      .values({
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        platform_integration_id: params.platformIntegrationId || null,
        repo_full_name: params.repoFullName,
        source: params.source,
        source_id: params.source_id,
        severity: params.severity,
        ghsa_id: params.ghsa_id,
        cve_id: params.cve_id,
        package_name: params.package_name,
        package_ecosystem: params.package_ecosystem,
        vulnerable_version_range: params.vulnerable_version_range,
        patched_version: params.patched_version,
        manifest_path: params.manifest_path,
        title: params.title,
        description: params.description,
        status: params.status,
        ignored_reason: params.ignored_reason,
        ignored_by: params.ignored_by,
        fixed_at: params.fixed_at,
        sla_due_at: params.slaDueAt?.toISOString() || null,
        dependabot_html_url: params.dependabot_html_url,
        raw_data: params.raw_data,
        first_detected_at: params.first_detected_at,
        // Additional metadata
        cwe_ids: params.cwe_ids,
        cvss_score: params.cvss_score?.toString() || null,
        dependency_scope: params.dependency_scope,
      })
      .returning({ id: security_findings.id });

    return finding.id;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createSecurityFinding' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Upserts a security finding (create or update based on unique constraint)
 * Uses repo_full_name + source + source_id as the unique key
 */
export async function upsertSecurityFinding(params: CreateFindingParams): Promise<string> {
  try {
    const owner = toOwner(params.owner);

    const [finding] = await db
      .insert(security_findings)
      .values({
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        platform_integration_id: params.platformIntegrationId || null,
        repo_full_name: params.repoFullName,
        source: params.source,
        source_id: params.source_id,
        severity: params.severity,
        ghsa_id: params.ghsa_id,
        cve_id: params.cve_id,
        package_name: params.package_name,
        package_ecosystem: params.package_ecosystem,
        vulnerable_version_range: params.vulnerable_version_range,
        patched_version: params.patched_version,
        manifest_path: params.manifest_path,
        title: params.title,
        description: params.description,
        status: params.status,
        ignored_reason: params.ignored_reason,
        ignored_by: params.ignored_by,
        fixed_at: params.fixed_at,
        sla_due_at: params.slaDueAt?.toISOString() || null,
        dependabot_html_url: params.dependabot_html_url,
        raw_data: params.raw_data,
        first_detected_at: params.first_detected_at,
        // Additional metadata
        cwe_ids: params.cwe_ids,
        cvss_score: params.cvss_score?.toString() || null,
        dependency_scope: params.dependency_scope,
      })
      .onConflictDoUpdate({
        target: [
          security_findings.repo_full_name,
          security_findings.source,
          security_findings.source_id,
        ],
        set: {
          severity: params.severity,
          ghsa_id: params.ghsa_id,
          cve_id: params.cve_id,
          vulnerable_version_range: params.vulnerable_version_range,
          patched_version: params.patched_version,
          title: params.title,
          description: params.description,
          status: params.status,
          ignored_reason: params.ignored_reason,
          ignored_by: params.ignored_by,
          fixed_at: params.fixed_at,
          sla_due_at: params.slaDueAt?.toISOString() || null,
          dependabot_html_url: params.dependabot_html_url,
          raw_data: params.raw_data,
          // Additional metadata
          cwe_ids: params.cwe_ids,
          cvss_score: params.cvss_score?.toString() || null,
          dependency_scope: params.dependency_scope,
          last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        },
      })
      .returning({ id: security_findings.id });

    return finding.id;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'upsertSecurityFinding' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Gets a security finding by ID
 */
export async function getSecurityFindingById(findingId: string): Promise<SecurityFinding | null> {
  try {
    const [finding] = await db
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, findingId))
      .limit(1);

    return finding || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getSecurityFindingById' },
      extra: { findingId },
    });
    throw error;
  }
}

/**
 * Exploitability filter type
 */
type ExploitabilityFilter = 'all' | 'exploitable' | 'not_exploitable';

/**
 * Suggested action filter type
 */
type SuggestedActionFilter = 'all' | 'dismissable';

/**
 * Analysis status filter type
 */
type AnalysisStatusFilter = 'all' | 'not_analyzed' | 'pending' | 'running' | 'completed' | 'failed';

/**
 * Parameters for listing security findings
 */
type ListFindingsParams = {
  owner: SecurityReviewOwner;
  limit?: number;
  offset?: number;
  status?: SecurityFindingStatusFilter;
  severity?: SecuritySeverity;
  repoFullName?: string;
  packageName?: string;
  exploitability?: ExploitabilityFilter;
  suggestedAction?: SuggestedActionFilter;
  analysisStatus?: AnalysisStatusFilter;
};

/**
 * Lists security findings for an owner
 */
export async function listSecurityFindings(params: ListFindingsParams): Promise<SecurityFinding[]> {
  try {
    const {
      owner,
      limit = 50,
      offset = 0,
      status,
      severity,
      repoFullName,
      packageName,
      exploitability,
      suggestedAction,
      analysisStatus,
    } = params;
    const ownerConverted = toOwner(owner);

    const conditions = [];

    // Owner condition
    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    // Optional filters
    if (status) {
      if (status === 'closed') {
        conditions.push(
          or(eq(security_findings.status, 'fixed'), eq(security_findings.status, 'ignored'))
        );
      } else {
        conditions.push(eq(security_findings.status, status));
      }
    }
    if (severity) {
      conditions.push(eq(security_findings.severity, severity));
    }
    if (repoFullName) {
      conditions.push(eq(security_findings.repo_full_name, repoFullName));
    }
    if (packageName) {
      conditions.push(eq(security_findings.package_name, packageName));
    }
    // Exploitability filter - filters based on analysis.sandboxAnalysis.isExploitable
    if (exploitability && exploitability !== 'all') {
      if (exploitability === 'exploitable') {
        // isExploitable === true
        conditions.push(
          sql`(${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable')::boolean = true`
        );
      } else if (exploitability === 'not_exploitable') {
        // isExploitable === false
        conditions.push(
          sql`(${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable')::boolean = false`
        );
      }
    }
    // Suggested action filter - filters based on triage or sandbox suggestedAction = 'dismiss'
    if (suggestedAction && suggestedAction !== 'all') {
      if (suggestedAction === 'dismissable') {
        // Either triage.suggestedAction = 'dismiss' OR sandboxAnalysis.suggestedAction = 'dismiss'
        conditions.push(
          or(
            sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss'`,
            sql`(${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction') = 'dismiss'`
          )
        );
      }
    }
    // Analysis status filter - filters based on analysis_status column
    if (analysisStatus && analysisStatus !== 'all') {
      if (analysisStatus === 'not_analyzed') {
        // analysis_status is null (never analyzed)
        conditions.push(sql`${security_findings.analysis_status} IS NULL`);
      } else {
        // Match specific analysis status
        conditions.push(eq(security_findings.analysis_status, analysisStatus));
      }
    }

    // Sort by severity (critical > high > medium > low) then by created_at descending
    const severityOrder = sql`CASE ${security_findings.severity}
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      WHEN 'low' THEN 4
      ELSE 5
    END`;

    const findings = await db
      .select()
      .from(security_findings)
      .where(and(...conditions))
      .orderBy(severityOrder, desc(security_findings.created_at))
      .limit(limit)
      .offset(offset);

    return findings;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listSecurityFindings' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Counts security findings for an owner
 */
export async function countSecurityFindings(params: {
  owner: SecurityReviewOwner;
  status?: SecurityFindingStatusFilter;
  severity?: SecuritySeverity;
  repoFullName?: string;
}): Promise<number> {
  try {
    const { owner, status, severity, repoFullName } = params;
    const ownerConverted = toOwner(owner);

    const conditions = [];

    // Owner condition
    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    // Optional filters
    if (status) {
      if (status === 'closed') {
        conditions.push(
          or(eq(security_findings.status, 'fixed'), eq(security_findings.status, 'ignored'))
        );
      } else {
        conditions.push(eq(security_findings.status, status));
      }
    }
    if (severity) {
      conditions.push(eq(security_findings.severity, severity));
    }
    if (repoFullName) {
      conditions.push(eq(security_findings.repo_full_name, repoFullName));
    }

    const result = await db
      .select({ count: count() })
      .from(security_findings)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'countSecurityFindings' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Gets summary counts by severity for an owner
 */
export async function getSecurityFindingsSummary(params: {
  owner: SecurityReviewOwner;
  repoFullName?: string;
  status?: SecurityFindingStatusFilter;
}): Promise<{
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  open: number;
  fixed: number;
  ignored: number;
}> {
  try {
    const { owner, repoFullName, status } = params;
    const ownerConverted = toOwner(owner);

    const baseConditions = [];

    // Owner condition
    if (ownerConverted.type === 'org') {
      baseConditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      baseConditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    if (repoFullName) {
      baseConditions.push(eq(security_findings.repo_full_name, repoFullName));
    }

    if (status) {
      if (status === 'closed') {
        baseConditions.push(
          or(eq(security_findings.status, 'fixed'), eq(security_findings.status, 'ignored'))
        );
      } else {
        baseConditions.push(eq(security_findings.status, status));
      }
    }

    // Get counts by severity
    const severityCounts = await db
      .select({
        severity: security_findings.severity,
        count: count(),
      })
      .from(security_findings)
      .where(and(...baseConditions))
      .groupBy(security_findings.severity);

    // Get counts by status
    const statusCounts = await db
      .select({
        status: security_findings.status,
        count: count(),
      })
      .from(security_findings)
      .where(and(...baseConditions))
      .groupBy(security_findings.status);

    const severityMap = Object.fromEntries(severityCounts.map(s => [s.severity, s.count]));
    const statusMap = Object.fromEntries(statusCounts.map(s => [s.status, s.count]));

    const total =
      (severityMap['critical'] || 0) +
      (severityMap['high'] || 0) +
      (severityMap['medium'] || 0) +
      (severityMap['low'] || 0);

    return {
      total,
      critical: severityMap['critical'] || 0,
      high: severityMap['high'] || 0,
      medium: severityMap['medium'] || 0,
      low: severityMap['low'] || 0,
      open: statusMap['open'] || 0,
      fixed: statusMap['fixed'] || 0,
      ignored: statusMap['ignored'] || 0,
    };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getSecurityFindingsSummary' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Updates the status of a security finding
 */
export async function updateSecurityFindingStatus(
  findingId: string,
  status: SecurityFindingStatus,
  updates: {
    ignoredReason?: string;
    ignoredBy?: string;
    fixedAt?: Date;
  } = {}
): Promise<void> {
  try {
    const updateData: Partial<NewSecurityFinding> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (updates.ignoredReason !== undefined) {
      updateData.ignored_reason = updates.ignoredReason;
    }
    if (updates.ignoredBy !== undefined) {
      updateData.ignored_by = updates.ignoredBy;
    }
    if (updates.fixedAt !== undefined) {
      updateData.fixed_at = updates.fixedAt.toISOString();
    }

    await db.update(security_findings).set(updateData).where(eq(security_findings.id, findingId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateSecurityFindingStatus' },
      extra: { findingId, status, updates },
    });
    throw error;
  }
}

/**
 * Gets distinct repositories with security findings for an owner
 */
export async function getRepositoriesWithFindings(owner: SecurityReviewOwner): Promise<string[]> {
  try {
    const ownerConverted = toOwner(owner);

    const condition =
      ownerConverted.type === 'org'
        ? eq(security_findings.owned_by_organization_id, ownerConverted.id)
        : eq(security_findings.owned_by_user_id, ownerConverted.id);

    const repos = await db
      .selectDistinct({ repo_full_name: security_findings.repo_full_name })
      .from(security_findings)
      .where(condition);

    return repos.map(r => r.repo_full_name);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getRepositoriesWithFindings' },
      extra: { owner },
    });
    throw error;
  }
}

/**
 * Finds an existing security finding by source
 */
export async function findSecurityFindingBySource(
  repoFullName: string,
  source: string,
  sourceId: string
): Promise<SecurityFinding | null> {
  try {
    const [finding] = await db
      .select()
      .from(security_findings)
      .where(
        and(
          eq(security_findings.repo_full_name, repoFullName),
          eq(security_findings.source, source),
          eq(security_findings.source_id, sourceId)
        )
      )
      .limit(1);

    return finding || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findSecurityFindingBySource' },
      extra: { repoFullName, source, sourceId },
    });
    throw error;
  }
}

/**
 * Gets the most recent last_synced_at timestamp for an owner's findings
 * Optionally filtered by repository
 */
export async function getLastSyncTime(params: {
  owner: SecurityReviewOwner;
  repoFullName?: string;
}): Promise<string | null> {
  try {
    const { owner, repoFullName } = params;
    const ownerConverted = toOwner(owner);

    const conditions = [];

    // Owner condition
    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    // Optional repo filter
    if (repoFullName) {
      conditions.push(eq(security_findings.repo_full_name, repoFullName));
    }

    const result = await db
      .select({ lastSyncedAt: max(security_findings.last_synced_at) })
      .from(security_findings)
      .where(and(...conditions));

    return result[0]?.lastSyncedAt || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getLastSyncTime' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Gets repositories with findings that are not in the list of accessible repositories.
 * These are "orphaned" repositories - they have findings but the GitHub integration
 * no longer has access to them.
 */
export async function getOrphanedRepositoriesWithFindingCounts(params: {
  owner: SecurityReviewOwner;
  accessibleRepoFullNames: string[];
}): Promise<{ repoFullName: string; findingCount: number }[]> {
  try {
    const { owner, accessibleRepoFullNames } = params;
    const ownerConverted = toOwner(owner);

    const conditions = [];

    // Owner condition
    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    // Get all repositories with findings for this owner
    const reposWithFindings = await db
      .select({
        repoFullName: security_findings.repo_full_name,
        findingCount: count(),
      })
      .from(security_findings)
      .where(and(...conditions))
      .groupBy(security_findings.repo_full_name);

    // Filter to only include repos that are NOT in the accessible list
    const orphanedRepos = reposWithFindings.filter(
      repo => !accessibleRepoFullNames.includes(repo.repoFullName)
    );

    return orphanedRepos;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getOrphanedRepositoriesWithFindingCounts' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Deletes all security findings for a specific repository owned by the given owner.
 * Returns the count of deleted findings.
 */
export async function deleteFindingsByRepository(params: {
  owner: SecurityReviewOwner;
  repoFullName: string;
}): Promise<{ deletedCount: number }> {
  try {
    const { owner, repoFullName } = params;
    const ownerConverted = toOwner(owner);

    const conditions = [];

    // Owner condition
    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

    // Repository condition
    conditions.push(eq(security_findings.repo_full_name, repoFullName));

    // Delete findings and get count
    const result = await db
      .delete(security_findings)
      .where(and(...conditions))
      .returning({ id: security_findings.id });

    return { deletedCount: result.length };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'deleteFindingsByRepository' },
      extra: { params },
    });
    throw error;
  }
}
