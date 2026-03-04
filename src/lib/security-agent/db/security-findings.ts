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

type Owner = { type: 'org'; id: string } | { type: 'user'; id: string };

function toOwner(owner: SecurityReviewOwner): Owner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

type CreateFindingParams = ParsedSecurityFinding & {
  owner: SecurityReviewOwner;
  platformIntegrationId?: string;
  repoFullName: string;
  slaDueAt?: Date;
};

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

export type UpsertSecurityFindingResult = {
  findingId: string;
  wasInserted: boolean;
  previousStatus: SecurityFindingStatus | null;
  findingCreatedAt: string;
};

/** Upsert using repo_full_name + source + source_id as the unique key. */
export async function upsertSecurityFinding(
  params: CreateFindingParams
): Promise<UpsertSecurityFindingResult> {
  try {
    const owner = toOwner(params.owner);

    const { rows } = await db.execute<{
      findingId: string;
      wasInserted: boolean;
      previousStatus: SecurityFindingStatus | null;
      findingCreatedAt: string;
    }>(sql`
      WITH existing_match AS (
        SELECT ${security_findings.id} AS id,
               ${security_findings.status} AS previous_status,
               ${security_findings.created_at} AS created_at
        FROM ${security_findings}
        WHERE ${security_findings.repo_full_name} = ${params.repoFullName}
          AND ${security_findings.source} = ${params.source}
          AND ${security_findings.source_id} = ${params.source_id}
        FOR UPDATE
      ),
      updated AS (
        UPDATE ${security_findings}
        SET
          ${sql.identifier(security_findings.severity.name)} = ${params.severity},
          ${sql.identifier(security_findings.ghsa_id.name)} = ${params.ghsa_id},
          ${sql.identifier(security_findings.cve_id.name)} = ${params.cve_id},
          ${sql.identifier(security_findings.vulnerable_version_range.name)} = ${params.vulnerable_version_range},
          ${sql.identifier(security_findings.patched_version.name)} = ${params.patched_version},
          ${sql.identifier(security_findings.title.name)} = ${params.title},
          ${sql.identifier(security_findings.description.name)} = ${params.description},
          ${sql.identifier(security_findings.status.name)} = ${params.status},
          ${sql.identifier(security_findings.ignored_reason.name)} = ${params.ignored_reason},
          ${sql.identifier(security_findings.ignored_by.name)} = ${params.ignored_by},
          ${sql.identifier(security_findings.fixed_at.name)} = ${params.fixed_at},
          ${sql.identifier(security_findings.sla_due_at.name)} = ${params.slaDueAt?.toISOString() || null},
          ${sql.identifier(security_findings.dependabot_html_url.name)} = ${params.dependabot_html_url},
          ${sql.identifier(security_findings.raw_data.name)} = ${params.raw_data},
          ${sql.identifier(security_findings.cwe_ids.name)} = ${sql.param(params.cwe_ids)}::text[],
          ${sql.identifier(security_findings.cvss_score.name)} = ${params.cvss_score?.toString() || null},
          ${sql.identifier(security_findings.dependency_scope.name)} = ${params.dependency_scope},
          ${sql.identifier(security_findings.last_synced_at.name)} = now(),
          ${sql.identifier(security_findings.updated_at.name)} = now()
        FROM existing_match
        WHERE ${security_findings.id} = existing_match.id
        RETURNING
          ${security_findings.id} AS id,
          existing_match.previous_status AS previous_status,
          ${security_findings.created_at} AS created_at
      ),
      inserted AS (
        INSERT INTO ${security_findings} (
          ${sql.identifier(security_findings.owned_by_organization_id.name)},
          ${sql.identifier(security_findings.owned_by_user_id.name)},
          ${sql.identifier(security_findings.platform_integration_id.name)},
          ${sql.identifier(security_findings.repo_full_name.name)},
          ${sql.identifier(security_findings.source.name)},
          ${sql.identifier(security_findings.source_id.name)},
          ${sql.identifier(security_findings.severity.name)},
          ${sql.identifier(security_findings.ghsa_id.name)},
          ${sql.identifier(security_findings.cve_id.name)},
          ${sql.identifier(security_findings.package_name.name)},
          ${sql.identifier(security_findings.package_ecosystem.name)},
          ${sql.identifier(security_findings.vulnerable_version_range.name)},
          ${sql.identifier(security_findings.patched_version.name)},
          ${sql.identifier(security_findings.manifest_path.name)},
          ${sql.identifier(security_findings.title.name)},
          ${sql.identifier(security_findings.description.name)},
          ${sql.identifier(security_findings.status.name)},
          ${sql.identifier(security_findings.ignored_reason.name)},
          ${sql.identifier(security_findings.ignored_by.name)},
          ${sql.identifier(security_findings.fixed_at.name)},
          ${sql.identifier(security_findings.sla_due_at.name)},
          ${sql.identifier(security_findings.dependabot_html_url.name)},
          ${sql.identifier(security_findings.raw_data.name)},
          ${sql.identifier(security_findings.first_detected_at.name)},
          ${sql.identifier(security_findings.cwe_ids.name)},
          ${sql.identifier(security_findings.cvss_score.name)},
          ${sql.identifier(security_findings.dependency_scope.name)}
        )
        SELECT
          ${owner.type === 'org' ? owner.id : null},
          ${owner.type === 'user' ? owner.id : null},
          ${params.platformIntegrationId || null},
          ${params.repoFullName},
          ${params.source},
          ${params.source_id},
          ${params.severity},
          ${params.ghsa_id},
          ${params.cve_id},
          ${params.package_name},
          ${params.package_ecosystem},
          ${params.vulnerable_version_range},
          ${params.patched_version},
          ${params.manifest_path},
          ${params.title},
          ${params.description},
          ${params.status},
          ${params.ignored_reason},
          ${params.ignored_by},
          ${params.fixed_at},
          ${params.slaDueAt?.toISOString() || null},
          ${params.dependabot_html_url},
          ${params.raw_data},
          ${params.first_detected_at},
          ${sql.param(params.cwe_ids)}::text[],
          ${params.cvss_score?.toString() || null},
          ${params.dependency_scope}
        WHERE NOT EXISTS (SELECT 1 FROM updated)
        ON CONFLICT (${sql.identifier(security_findings.repo_full_name.name)}, ${sql.identifier(security_findings.source.name)}, ${sql.identifier(security_findings.source_id.name)}) DO NOTHING
        RETURNING ${security_findings.id} AS id,
          NULL::text AS previous_status,
          ${security_findings.created_at} AS created_at
      ),
      -- fallback: concurrent insert race — previous_status reflects the current row state
      -- (written by the concurrent winner), not the true pre-update value. This means
      -- syncAutoAnalysisQueueForFinding may misidentify a status transition during races.
      -- Acceptable because the concurrent winner's sync call will have the correct value.
      fallback AS (
        SELECT
          ${security_findings.id} AS id,
          ${security_findings.status} AS previous_status,
          ${security_findings.created_at} AS created_at
        FROM ${security_findings}
        WHERE ${security_findings.repo_full_name} = ${params.repoFullName}
          AND ${security_findings.source} = ${params.source}
          AND ${security_findings.source_id} = ${params.source_id}
          AND NOT EXISTS (SELECT 1 FROM updated)
          AND NOT EXISTS (SELECT 1 FROM inserted)
        LIMIT 1
      ),
      chosen AS (
        SELECT id, false AS was_inserted, previous_status, created_at FROM updated
        UNION ALL
        SELECT id, true AS was_inserted, previous_status, created_at FROM inserted
        UNION ALL
        SELECT id, false AS was_inserted, previous_status, created_at FROM fallback
      )
      SELECT
        chosen.id AS "findingId",
        chosen.was_inserted AS "wasInserted",
        chosen.previous_status AS "previousStatus",
        chosen.created_at AS "findingCreatedAt"
      FROM chosen
      LIMIT 1
    `);

    const finding = rows[0];
    if (!finding) {
      throw new Error('Failed to upsert security finding');
    }

    return finding;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'upsertSecurityFinding' },
      extra: { params },
    });
    throw error;
  }
}

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

type ExploitabilityFilter = 'all' | 'exploitable' | 'not_exploitable';
type SuggestedActionFilter = 'all' | 'dismissable';
type AnalysisStatusFilter = 'all' | 'not_analyzed' | 'pending' | 'running' | 'completed' | 'failed';

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

    if (ownerConverted.type === 'org') {
      conditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      conditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }

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
    if (suggestedAction && suggestedAction !== 'all') {
      if (suggestedAction === 'dismissable') {
        conditions.push(
          or(
            sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss'`,
            sql`(${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction') = 'dismiss'`
          )
        );
      }
    }
    if (analysisStatus && analysisStatus !== 'all') {
      if (analysisStatus === 'not_analyzed') {
        conditions.push(sql`${security_findings.analysis_status} IS NULL`);
      } else {
        conditions.push(eq(security_findings.analysis_status, analysisStatus));
      }
    }

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

    const severityCounts = await db
      .select({
        severity: security_findings.severity,
        count: count(),
      })
      .from(security_findings)
      .where(and(...baseConditions))
      .groupBy(security_findings.severity);

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

    const reposWithFindings = await db
      .select({
        repoFullName: security_findings.repo_full_name,
        findingCount: count(),
      })
      .from(security_findings)
      .where(and(...conditions))
      .groupBy(security_findings.repo_full_name);

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
