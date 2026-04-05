import { db } from '@/lib/drizzle';
import { security_findings, agent_configs } from '@kilocode/db/schema';
import { eq, and, desc, count, sql, max, or, type SQL } from 'drizzle-orm';
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
  /** The status actually persisted — may differ from the input when a superseded row is preserved. */
  effectiveStatus: SecurityFindingStatus;
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
      effectiveStatus: SecurityFindingStatus;
      findingCreatedAt: string;
    }>(sql`
      WITH existing_match AS (
        SELECT ${security_findings.id} AS id,
               ${security_findings.status} AS previous_status,
               ${security_findings.ignored_reason} AS ignored_reason,
               ${security_findings.ignored_by} AS ignored_by,
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
          ${sql.identifier(security_findings.status.name)} = CASE
            WHEN existing_match.ignored_reason LIKE 'superseded:%' THEN existing_match.previous_status
            ELSE ${params.status}
          END,
          ${sql.identifier(security_findings.ignored_reason.name)} = CASE
            WHEN existing_match.ignored_reason LIKE 'superseded:%' THEN existing_match.ignored_reason
            ELSE ${params.ignored_reason}
          END,
          ${sql.identifier(security_findings.ignored_by.name)} = CASE
            WHEN existing_match.ignored_reason LIKE 'superseded:%' THEN existing_match.ignored_by
            ELSE ${params.ignored_by}
          END,
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
          ${security_findings.status} AS effective_status,
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
          ${security_findings.status} AS effective_status,
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
          ${security_findings.status} AS effective_status,
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
        SELECT id, false AS was_inserted, previous_status, effective_status, created_at FROM updated
        UNION ALL
        SELECT id, true AS was_inserted, previous_status, effective_status, created_at FROM inserted
        UNION ALL
        SELECT id, false AS was_inserted, previous_status, effective_status, created_at FROM fallback
      )
      SELECT
        chosen.id AS "findingId",
        chosen.was_inserted AS "wasInserted",
        chosen.previous_status AS "previousStatus",
        chosen.effective_status AS "effectiveStatus",
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

/**
 * GitHub sometimes creates a new Dependabot alert (new alert number) for the
 * same GHSA/package/manifest when an advisory is updated. Keep the newest
 * alert open and mark older duplicates as ignored with a superseded reference.
 */
export type SupersedeResult = { count: number; supersededFindingIds: string[] };

export async function supersedeDuplicateFindings(repoFullName: string): Promise<SupersedeResult> {
  try {
    const { rows } = await db.execute<{ id: string }>(sql`
    WITH ranked AS (
      SELECT
        ${security_findings.id} AS id,
        ROW_NUMBER() OVER (
          PARTITION BY ${security_findings.repo_full_name},
                       ${security_findings.source},
                       ${security_findings.ghsa_id},
                       ${security_findings.package_name},
                       ${security_findings.manifest_path}
          ORDER BY CASE WHEN ${security_findings.source_id} ~ '^[0-9]+$' THEN ${security_findings.source_id}::int ELSE 0 END DESC
        ) AS rn,
        FIRST_VALUE(${security_findings.id}) OVER (
          PARTITION BY ${security_findings.repo_full_name},
                       ${security_findings.source},
                       ${security_findings.ghsa_id},
                       ${security_findings.package_name},
                       ${security_findings.manifest_path}
          ORDER BY CASE WHEN ${security_findings.source_id} ~ '^[0-9]+$' THEN ${security_findings.source_id}::int ELSE 0 END DESC
        ) AS canonical_id
      FROM ${security_findings}
      WHERE ${security_findings.repo_full_name} = ${repoFullName}
        AND ${security_findings.source} = 'dependabot'
        AND ${security_findings.ghsa_id} IS NOT NULL
        AND ${security_findings.status} = 'open'
    ),
    superseded AS (
      UPDATE ${security_findings}
      SET
        ${sql.identifier(security_findings.status.name)} = 'ignored',
        ${sql.identifier(security_findings.ignored_reason.name)} = 'superseded:' || ranked.canonical_id,
        ${sql.identifier(security_findings.ignored_by.name)} = 'system',
        ${sql.identifier(security_findings.updated_at.name)} = now()
      FROM ranked
      WHERE ${security_findings.id} = ranked.id
        AND ranked.rn > 1
      RETURNING ${security_findings.id}
    )
    SELECT id FROM superseded
  `);

    const supersededFindingIds = rows.map(r => r.id);
    return { count: supersededFindingIds.length, supersededFindingIds };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'supersedeDuplicateFindings' },
      extra: { repoFullName },
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

type OutcomeFilter =
  | 'all'
  | 'not_analyzed'
  | 'analyzing'
  | 'failed'
  | 'exploitable'
  | 'not_exploitable'
  | 'safe_to_dismiss'
  | 'needs_review'
  | 'triage_complete'
  | 'fixed'
  | 'dismissed';

type ListFindingsParams = {
  owner: SecurityReviewOwner;
  limit?: number;
  offset?: number;
  status?: SecurityFindingStatusFilter;
  severity?: SecuritySeverity;
  repoFullName?: string;
  packageName?: string;
  outcomeFilter?: OutcomeFilter;
  overdue?: boolean;
  sortBy?: 'severity_desc' | 'severity_asc' | 'sla_due_at_asc';
};

export async function listSecurityFindings(
  params: ListFindingsParams
): Promise<{ findings: SecurityFinding[]; totalCount: number }> {
  try {
    const {
      owner,
      limit = 50,
      offset = 0,
      status,
      severity,
      repoFullName,
      packageName,
      outcomeFilter,
      overdue,
      sortBy,
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
    if (overdue) {
      conditions.push(
        sql`${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} < now()`
      );
    }
    if (outcomeFilter && outcomeFilter !== 'all') {
      switch (outcomeFilter) {
        case 'not_analyzed':
          conditions.push(sql`${security_findings.analysis_status} IS NULL`);
          break;
        case 'analyzing':
          conditions.push(
            or(
              eq(security_findings.analysis_status, 'pending'),
              eq(security_findings.analysis_status, 'running')
            )
          );
          break;
        case 'failed':
          conditions.push(eq(security_findings.analysis_status, 'failed'));
          break;
        case 'exploitable':
          conditions.push(eq(security_findings.status, 'open'));
          conditions.push(eq(security_findings.analysis_status, 'completed'));
          conditions.push(
            sql`(${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true'`
          );
          break;
        case 'not_exploitable':
          conditions.push(eq(security_findings.status, 'open'));
          conditions.push(eq(security_findings.analysis_status, 'completed'));
          conditions.push(
            sql`(${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'false'`
          );
          break;
        case 'safe_to_dismiss':
          conditions.push(eq(security_findings.status, 'open'));
          conditions.push(eq(security_findings.analysis_status, 'completed'));
          conditions.push(
            sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss'`
          );
          // Exclude findings where sandbox has a definitive result, since
          // getOutcome() gives sandbox priority over triage. Without this a
          // finding triaged as "dismiss" but sandbox-confirmed as exploitable
          // would appear under "Safe to Dismiss" yet display as "Exploitable".
          conditions.push(
            sql`(${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown'`
          );
          break;
        case 'needs_review':
          conditions.push(eq(security_findings.status, 'open'));
          conditions.push(eq(security_findings.analysis_status, 'completed'));
          conditions.push(
            sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'manual_review'`
          );
          // Same as safe_to_dismiss: exclude findings where sandbox overrides triage.
          conditions.push(
            sql`(${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown'`
          );
          break;
        case 'triage_complete':
          // Triage done but no sandbox analysis yet; matches TriageSuggestedActionSchema = 'analyze_codebase'.
          // Coupled with OutcomeFilterSchema and getOutcome() in SecurityFindingRow.tsx.
          conditions.push(eq(security_findings.status, 'open'));
          conditions.push(eq(security_findings.analysis_status, 'completed'));
          conditions.push(
            sql`((${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown')`
          );
          conditions.push(
            sql`(${security_findings.analysis}->'triage'->>'suggestedAction') = 'analyze_codebase'`
          );
          break;
        case 'fixed':
          conditions.push(eq(security_findings.status, 'fixed'));
          break;
        case 'dismissed':
          conditions.push(eq(security_findings.status, 'ignored'));
          break;
      }
    }

    const whereClause = and(...conditions);

    // Sort order
    const severityOrder = sql`CASE ${security_findings.severity}
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      WHEN 'low' THEN 4
      ELSE 5
    END`;

    const severityOrderReversed = sql`CASE ${security_findings.severity}
      WHEN 'low' THEN 1
      WHEN 'medium' THEN 2
      WHEN 'high' THEN 3
      WHEN 'critical' THEN 4
      ELSE 0
    END`;

    let orderByClause: SQL[];
    if (sortBy === 'sla_due_at_asc') {
      orderByClause = [
        sql`${security_findings.sla_due_at} ASC NULLS LAST`,
        severityOrder,
        desc(security_findings.created_at),
      ];
    } else if (sortBy === 'severity_asc') {
      orderByClause = [severityOrderReversed, desc(security_findings.created_at)];
    } else {
      orderByClause = [severityOrder, desc(security_findings.created_at)];
    }

    // Run paginated query and count query in parallel
    const [findings, countResult] = await Promise.all([
      db
        .select()
        .from(security_findings)
        .where(whereClause)
        .orderBy(...orderByClause)
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(security_findings).where(whereClause),
    ]);

    return { findings, totalCount: countResult[0]?.count ?? 0 };
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

/** Read owner-level last_synced_at from agent_configs.runtime_state. */
async function getOwnerLastSyncedAt(ownerConverted: Owner): Promise<string | null> {
  const ownerCondition =
    ownerConverted.type === 'org'
      ? eq(agent_configs.owned_by_organization_id, ownerConverted.id)
      : eq(agent_configs.owned_by_user_id, ownerConverted.id);

  const configResult = await db
    .select({
      lastSyncedAt: sql<string | null>`${agent_configs.runtime_state}->>'last_synced_at'`,
    })
    .from(agent_configs)
    .where(
      and(
        ownerCondition,
        eq(agent_configs.agent_type, 'security_scan'),
        eq(agent_configs.platform, 'github')
      )
    )
    .limit(1);

  return configResult[0]?.lastSyncedAt ?? null;
}

export async function getLastSyncTime(params: {
  owner: SecurityReviewOwner;
  repoFullName?: string;
}): Promise<string | null> {
  try {
    const { owner, repoFullName } = params;
    const ownerConverted = toOwner(owner);

    // Owner-level: read from agent_configs.runtime_state (set by sync jobs).
    // Return null (not MAX(findings)) when runtime_state is missing — falling back to
    // findings would overstate freshness after partial sync failures.
    if (!repoFullName) {
      return await getOwnerLastSyncedAt(ownerConverted);
    }

    // Repo-specific: read MAX(last_synced_at) from findings for this repo.
    // Returns null for repos with zero findings — we lack per-repo sync metadata,
    // so falling back to the owner-level timestamp would overstate freshness for
    // repos added after the last full sync.
    const findingConditions: SQL[] = [];
    if (ownerConverted.type === 'org') {
      findingConditions.push(eq(security_findings.owned_by_organization_id, ownerConverted.id));
    } else {
      findingConditions.push(eq(security_findings.owned_by_user_id, ownerConverted.id));
    }
    findingConditions.push(eq(security_findings.repo_full_name, repoFullName));

    const result = await db
      .select({ lastSyncedAt: max(security_findings.last_synced_at) })
      .from(security_findings)
      .where(and(...findingConditions));

    return result[0]?.lastSyncedAt ?? null;
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
