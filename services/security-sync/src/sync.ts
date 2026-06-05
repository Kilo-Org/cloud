/**
 * Security Sync — Worker-side sync logic
 *
 * Uses Drizzle ORM via @kilocode/db for all database access (through Hyperdrive)
 * and the GitHub REST API via fetch (with tokens from GIT_TOKEN_SERVICE).
 */

import { z } from 'zod';
import { eq, and, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import {
  agent_configs,
  platform_integrations,
  security_findings,
  security_analysis_queue,
  security_analysis_owner_state,
  security_audit_log,
} from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import {
  decideAutoAnalysisEligibility,
  type AutoAnalysisMinSeverity,
} from '@kilocode/worker-utils/security-auto-analysis-policy';

const SecurityFindingSource = { DEPENDABOT: 'dependabot' } as const;

const AUTH_INVALID_SHORT_CIRCUIT_MS = 60 * 60 * 1000;
const AUTH_INVALID_WRITE_THROTTLE_MS = AUTH_INVALID_SHORT_CIRCUIT_MS;

const SecurityFindingStatus = {
  OPEN: 'open',
  FIXED: 'fixed',
  IGNORED: 'ignored',
} as const;
type SecurityFindingStatus = (typeof SecurityFindingStatus)[keyof typeof SecurityFindingStatus];

const securitySeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
type SecuritySeverity = z.infer<typeof securitySeveritySchema>;

const dependabotAlertStateSchema = z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']);
type DependabotAlertState = z.infer<typeof dependabotAlertStateSchema>;

const dependabotAlertRawSchema = z.object({
  number: z.number(),
  state: dependabotAlertStateSchema,
  dependency: z.object({
    package: z.object({ ecosystem: z.string(), name: z.string() }),
    manifest_path: z.string(),
    scope: z.enum(['development', 'runtime']).nullable(),
  }),
  security_advisory: z.object({
    ghsa_id: z.string(),
    cve_id: z.string().nullable(),
    summary: z.string(),
    description: z.string(),
    severity: securitySeveritySchema,
    cvss: z.object({ score: z.number(), vector_string: z.string().nullable() }).optional(),
    cwes: z.array(z.object({ cwe_id: z.string(), name: z.string() })).optional(),
  }),
  security_vulnerability: z.object({
    vulnerable_version_range: z.string(),
    first_patched_version: z.object({ identifier: z.string() }).nullable().optional(),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  fixed_at: z.string().datetime().nullable(),
  dismissed_at: z.string().datetime().nullable(),
  dismissed_by: z.object({ login: z.string() }).nullable().optional(),
  dismissed_reason: z.string().nullable().optional(),
  dismissed_comment: z.string().nullable().optional(),
  auto_dismissed_at: z.string().datetime().nullable().optional(),
  html_url: z.string(),
  url: z.string(),
});

type DependabotAlertRaw = z.infer<typeof dependabotAlertRawSchema>;

type ParsedSecurityFinding = {
  source: string;
  source_id: string;
  severity: SecuritySeverity;
  ghsa_id: string | null;
  cve_id: string | null;
  package_name: string;
  package_ecosystem: string;
  vulnerable_version_range: string | null;
  patched_version: string | null;
  manifest_path: string | null;
  title: string;
  description: string | null;
  status: SecurityFindingStatus;
  ignored_reason: string | null;
  ignored_by: string | null;
  fixed_at: string | null;
  dependabot_html_url: string | null;
  first_detected_at: string;
  raw_data: DependabotAlertRaw;
  cwe_ids: string[] | null;
  cvss_score: number | null;
  dependency_scope: 'development' | 'runtime' | null;
};

type SecurityAgentConfig = {
  sla_critical_days: number;
  sla_high_days: number;
  sla_medium_days: number;
  sla_low_days: number;
  repository_selection_mode: 'all' | 'selected';
  selected_repository_ids?: number[];
  auto_analysis_enabled: boolean;
  auto_analysis_min_severity: AutoAnalysisMinSeverity;
  auto_analysis_include_existing: boolean;
};

const securityAgentConfigSchema = z.object({
  sla_critical_days: z.number(),
  sla_high_days: z.number(),
  sla_medium_days: z.number(),
  sla_low_days: z.number(),
  repository_selection_mode: z.enum(['all', 'selected']),
  selected_repository_ids: z.array(z.number()).optional(),
  auto_analysis_enabled: z.boolean(),
  auto_analysis_min_severity: z.enum(['critical', 'high', 'medium', 'all']),
  auto_analysis_include_existing: z.boolean(),
});

const DEFAULT_SLA_CONFIG: SecurityAgentConfig = {
  sla_critical_days: 15,
  sla_high_days: 30,
  sla_medium_days: 45,
  sla_low_days: 90,
  repository_selection_mode: 'all',
  auto_analysis_enabled: false,
  auto_analysis_min_severity: 'high',
  auto_analysis_include_existing: false,
};

type SecurityReviewOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type SyncResult = {
  synced: number;
  errors: number;
  /** Repos where Dependabot alerts are permanently disabled (safe to skip) */
  skipped: number;
  /** Repos where the GitHub installation requires reauthorization */
  authInvalid: number;
  authInvalidRepos: string[];
  reauthRequired: boolean;
  /** Repos that returned 404 or are access-blocked (deleted/transferred/inaccessible) */
  staleRepos: string[];
};

type FetchAlertsResult =
  | { status: 'success'; alerts: DependabotAlertRaw[] }
  | { status: 'repo_not_found' }
  | { status: 'alerts_disabled' }
  | { status: 'access_blocked' }
  | { status: 'auth_invalid' };

function createEmptySyncResult(): SyncResult {
  return {
    synced: 0,
    errors: 0,
    skipped: 0,
    authInvalid: 0,
    authInvalidRepos: [],
    reauthRequired: false,
    staleRepos: [],
  };
}

function createAuthInvalidSyncResult(repositories: string[]): SyncResult {
  return {
    ...createEmptySyncResult(),
    authInvalid: repositories.length,
    authInvalidRepos: [...repositories],
    reauthRequired: true,
  };
}

function isOrgOwner(
  owner: SecurityReviewOwner
): owner is { organizationId: string; userId?: never } {
  return 'organizationId' in owner && Boolean(owner.organizationId);
}

function ownerFilter(owner: SecurityReviewOwner) {
  if (isOrgOwner(owner)) {
    return eq(agent_configs.owned_by_organization_id, owner.organizationId);
  }
  return eq(agent_configs.owned_by_user_id, owner.userId);
}

function integrationOwnerFilter(owner: SecurityReviewOwner) {
  if (isOrgOwner(owner)) {
    return eq(platform_integrations.owned_by_organization_id, owner.organizationId);
  }
  return eq(platform_integrations.owned_by_user_id, owner.userId);
}

function analysisOwnerStateFilter(owner: SecurityReviewOwner) {
  if (isOrgOwner(owner)) {
    return eq(security_analysis_owner_state.owned_by_organization_id, owner.organizationId);
  }
  return eq(security_analysis_owner_state.owned_by_user_id, owner.userId);
}

type EnabledOwnerConfig = {
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  installationId: string;
  repositories: string[];
  repoNameToId: Map<string, number>;
  slaConfig: SecurityAgentConfig;
  autoAnalysisEnabledAt: string | null;
  authInvalidAt: string | null;
  /** Number of selected_repository_ids that are no longer accessible via the installation.
   *  Non-zero means the app lost access to a configured repo — freshness must not advance. */
  missingSelectedRepoCount: number;
};

export async function getOwnerConfig(
  db: WorkerDb,
  owner: SecurityReviewOwner
): Promise<EnabledOwnerConfig | null> {
  // Get agent config
  const configs = await db
    .select({
      id: agent_configs.id,
      config: agent_configs.config,
      is_enabled: agent_configs.is_enabled,
    })
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.agent_type, 'security_scan'),
        eq(agent_configs.platform, 'github'),
        eq(agent_configs.is_enabled, true),
        ownerFilter(owner)
      )
    )
    .limit(1);

  if (configs.length === 0) return null;
  const agentConfig = configs[0];

  // Get platform integration
  const integrations = await db
    .select({
      id: platform_integrations.id,
      platform_installation_id: platform_integrations.platform_installation_id,
      permissions: platform_integrations.permissions,
      repositories: platform_integrations.repositories,
      authInvalidAt: platform_integrations.auth_invalid_at,
    })
    .from(platform_integrations)
    .where(
      and(
        integrationOwnerFilter(owner),
        eq(platform_integrations.platform, 'github'),
        isNotNull(platform_integrations.platform_installation_id)
      )
    )
    .limit(1);

  if (integrations.length === 0) return null;
  const integration = integrations[0];

  if (!integration.platform_installation_id) return null;

  // Check vulnerability_alerts permission
  const perms = integration.permissions;
  if (!perms || (perms.vulnerability_alerts !== 'read' && perms.vulnerability_alerts !== 'write')) {
    console.warn(`Integration ${integration.id} missing vulnerability_alerts permission, skipping`);
    return null;
  }

  // Filter repositories
  const allRepos = (integration.repositories ?? []).filter(
    r => typeof r.id === 'number' && typeof r.full_name === 'string' && r.full_name.length > 0
  );
  if (allRepos.length === 0) return null;

  const repoNameToId = new Map(allRepos.map(r => [r.full_name, r.id]));

  const parsed = securityAgentConfigSchema.partial().safeParse(agentConfig.config);
  if (!parsed.success) {
    console.warn('Invalid security agent config, skipping owner', { error: parsed.error.message });
    return null;
  }
  const securityConfig = parsed.data;
  let selectedRepos: string[];
  let missingSelectedRepoCount = 0;
  if (securityConfig.repository_selection_mode === 'selected') {
    const selectedIds = new Set(securityConfig.selected_repository_ids ?? []);
    if (selectedIds.size > 0) {
      const accessibleIds = new Set(allRepos.map(r => r.id));
      selectedRepos = allRepos.filter(r => selectedIds.has(r.id)).map(r => r.full_name);
      missingSelectedRepoCount = [...selectedIds].filter(id => !accessibleIds.has(id)).length;
    } else {
      // Mode is 'selected' but no repos are configured — don't fall through to 'all'
      selectedRepos = [];
    }
  } else {
    selectedRepos = allRepos.map(r => r.full_name);
  }

  if (selectedRepos.length === 0 && missingSelectedRepoCount === 0) return null;

  if (missingSelectedRepoCount > 0) {
    console.warn(`${missingSelectedRepoCount} selected repo(s) no longer accessible for owner`, {
      owner,
    });
  }

  const ownerStates = await db
    .select({ autoAnalysisEnabledAt: security_analysis_owner_state.auto_analysis_enabled_at })
    .from(security_analysis_owner_state)
    .where(analysisOwnerStateFilter(owner))
    .limit(1);

  return {
    owner,
    platformIntegrationId: integration.id,
    installationId: integration.platform_installation_id,
    repositories: selectedRepos,
    repoNameToId,
    slaConfig: { ...DEFAULT_SLA_CONFIG, ...securityConfig },
    autoAnalysisEnabledAt: ownerStates[0]?.autoAnalysisEnabledAt ?? null,
    authInvalidAt: integration.authInvalidAt,
    missingSelectedRepoCount,
  };
}

function isRecentTimestamp(value: string | null | undefined, windowMs: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < windowMs;
}

async function markIntegrationAuthInvalid(
  db: WorkerDb,
  platformIntegrationId: string
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await db
      .update(platform_integrations)
      .set({
        auth_invalid_at: now,
        auth_invalid_reason: 'github_dependabot_401',
        updated_at: now,
      })
      .where(
        and(
          eq(platform_integrations.id, platformIntegrationId),
          sql`(${platform_integrations.auth_invalid_at} IS NULL OR ${platform_integrations.auth_invalid_at} < now() - ${AUTH_INVALID_WRITE_THROTTLE_MS} * interval '1 millisecond')`
        )
      );
  } catch (error) {
    console.error('Failed to mark GitHub integration auth invalid', {
      error: error instanceof Error ? error.message : String(error),
      platformIntegrationId,
    });
  }
}

async function clearIntegrationAuthInvalid(
  db: WorkerDb,
  platformIntegrationId: string
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await db
      .update(platform_integrations)
      .set({
        auth_invalid_at: null,
        auth_invalid_reason: null,
        updated_at: now,
      })
      .where(
        and(
          eq(platform_integrations.id, platformIntegrationId),
          isNotNull(platform_integrations.auth_invalid_at)
        )
      );
  } catch (error) {
    console.error('Failed to clear GitHub integration auth invalid state', {
      error: error instanceof Error ? error.message : String(error),
      platformIntegrationId,
    });
  }
}

export async function fetchAllDependabotAlerts(
  token: string,
  repoOwner: string,
  repoName: string
): Promise<FetchAlertsResult> {
  const allAlerts: DependabotAlertRaw[] = [];
  let url: string | null =
    `https://api.github.com/repos/${repoOwner}/${repoName}/dependabot/alerts?per_page=100`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cloudflare-security-sync',
      },
    });

    if (response.status === 401) {
      return { status: 'auth_invalid' };
    }

    if (response.status === 404) {
      return { status: 'repo_not_found' };
    }

    // 451 "Unavailable for Legal Reasons" — repo is blocked, won't recover.
    if (response.status === 451) {
      return { status: 'access_blocked' };
    }

    if (!response.ok) {
      const body = await response.text();

      if (
        (response.status === 403 || response.status === 422) &&
        body.includes('repository access blocked')
      ) {
        return { status: 'access_blocked' };
      }

      if (
        (response.status === 403 || response.status === 422) &&
        (body.includes('Dependabot alerts are disabled') ||
          body.includes('Dependabot alerts are not available') ||
          body.includes('archived repositories') ||
          body.includes('archived repository'))
      ) {
        return { status: 'alerts_disabled' };
      }

      throw new Error(`GitHub API error ${response.status} for ${repoOwner}/${repoName}: ${body}`);
    }

    const json: unknown = await response.json();
    const data = z.array(dependabotAlertRawSchema).parse(json);
    allAlerts.push(...data);

    // Follow pagination via Link header
    const linkHeader = response.headers.get('link');
    url = parseLinkNext(linkHeader);

    // Check rate limit
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null && Number(remaining) < 100) {
      console.warn(
        `GitHub API rate limit low: ${remaining} remaining for ${repoOwner}/${repoName}`
      );
    }
  }

  return { status: 'success', alerts: allAlerts };
}

function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function mapDependabotStateToStatus(state: DependabotAlertState): SecurityFindingStatus {
  switch (state) {
    case 'open':
      return SecurityFindingStatus.OPEN;
    case 'fixed':
      return SecurityFindingStatus.FIXED;
    case 'dismissed':
    case 'auto_dismissed':
      return SecurityFindingStatus.IGNORED;
  }
}

function parseDependabotAlert(alert: DependabotAlertRaw): ParsedSecurityFinding {
  const status = mapDependabotStateToStatus(alert.state);

  return {
    source: SecurityFindingSource.DEPENDABOT,
    source_id: alert.number.toString(),
    severity: alert.security_advisory.severity,
    ghsa_id: alert.security_advisory.ghsa_id,
    cve_id: alert.security_advisory.cve_id,
    package_name: alert.dependency.package.name,
    package_ecosystem: alert.dependency.package.ecosystem,
    vulnerable_version_range: alert.security_vulnerability.vulnerable_version_range,
    patched_version: alert.security_vulnerability.first_patched_version?.identifier ?? null,
    manifest_path: alert.dependency.manifest_path,
    title: alert.security_advisory.summary,
    description: alert.security_advisory.description,
    status,
    ignored_reason:
      status === SecurityFindingStatus.IGNORED ? (alert.dismissed_reason ?? null) : null,
    ignored_by:
      status === SecurityFindingStatus.IGNORED ? (alert.dismissed_by?.login ?? null) : null,
    fixed_at: alert.fixed_at,
    dependabot_html_url: alert.html_url,
    first_detected_at: alert.created_at,
    raw_data: alert,
    cwe_ids: alert.security_advisory.cwes?.map(cwe => cwe.cwe_id) ?? null,
    cvss_score: alert.security_advisory.cvss?.score ?? null,
    dependency_scope: alert.dependency.scope ?? null,
  };
}

function getSlaForSeverity(config: SecurityAgentConfig, severity: SecuritySeverity): number {
  switch (severity) {
    case 'critical':
      return config.sla_critical_days;
    case 'high':
      return config.sla_high_days;
    case 'medium':
      return config.sla_medium_days;
    case 'low':
      return config.sla_low_days;
  }
}

function calculateSlaDueAt(firstDetectedAt: string, slaDays: number): string {
  const date = new Date(firstDetectedAt);
  date.setDate(date.getDate() + slaDays);
  return date.toISOString();
}

const securityFindingStatusSchema = z.enum([
  SecurityFindingStatus.OPEN,
  SecurityFindingStatus.FIXED,
  SecurityFindingStatus.IGNORED,
]);

const upsertSecurityFindingResultSchema = z.object({
  findingId: z.string().uuid(),
  previousStatus: securityFindingStatusSchema.nullable(),
  effectiveStatus: securityFindingStatusSchema,
  findingCreatedAt: z
    .union([z.string(), z.date()])
    .transform(value =>
      value instanceof Date ? value.toISOString() : new Date(value).toISOString()
    ),
});

type UpsertSecurityFindingResult = z.infer<typeof upsertSecurityFindingResultSchema>;

async function upsertSecurityFinding(
  db: WorkerDb,
  params: {
    finding: ParsedSecurityFinding;
    owner: SecurityReviewOwner;
    platformIntegrationId: string;
    repoFullName: string;
    slaDueAt: string;
  }
): Promise<UpsertSecurityFindingResult> {
  const { finding, owner, platformIntegrationId, repoFullName, slaDueAt } = params;
  const ownerOrganizationId = isOrgOwner(owner) ? owner.organizationId : null;
  const ownerUserId = isOrgOwner(owner) ? null : owner.userId;

  const result = await db.execute<Record<string, unknown>>(sql`
    WITH existing_match AS (
      SELECT ${security_findings.id} AS id,
             ${security_findings.status} AS previous_status
      FROM ${security_findings}
      WHERE ${security_findings.repo_full_name} = ${repoFullName}
        AND ${security_findings.source} = ${finding.source}
        AND ${security_findings.source_id} = ${finding.source_id}
      FOR UPDATE
    ),
    upserted AS (
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
        ${ownerOrganizationId},
        ${ownerUserId},
        ${platformIntegrationId},
        ${repoFullName},
        ${finding.source},
        ${finding.source_id},
        ${finding.severity},
        ${finding.ghsa_id},
        ${finding.cve_id},
        ${finding.package_name},
        ${finding.package_ecosystem},
        ${finding.vulnerable_version_range},
        ${finding.patched_version},
        ${finding.manifest_path},
        ${finding.title},
        ${finding.description},
        ${finding.status},
        ${finding.ignored_reason},
        ${finding.ignored_by},
        ${finding.fixed_at},
        ${slaDueAt},
        ${finding.dependabot_html_url},
        ${finding.raw_data},
        ${finding.first_detected_at},
        ${sql.param(finding.cwe_ids)}::text[],
        ${finding.cvss_score?.toString() ?? null},
        ${finding.dependency_scope}
      FROM (SELECT 1) AS input
      LEFT JOIN existing_match ON true
      ON CONFLICT (${sql.identifier(security_findings.repo_full_name.name)}, ${sql.identifier(security_findings.source.name)}, ${sql.identifier(security_findings.source_id.name)}) DO UPDATE
      SET
        ${sql.identifier(security_findings.severity.name)} = EXCLUDED.${sql.identifier(security_findings.severity.name)},
        ${sql.identifier(security_findings.ghsa_id.name)} = EXCLUDED.${sql.identifier(security_findings.ghsa_id.name)},
        ${sql.identifier(security_findings.cve_id.name)} = EXCLUDED.${sql.identifier(security_findings.cve_id.name)},
        ${sql.identifier(security_findings.vulnerable_version_range.name)} = EXCLUDED.${sql.identifier(security_findings.vulnerable_version_range.name)},
        ${sql.identifier(security_findings.patched_version.name)} = EXCLUDED.${sql.identifier(security_findings.patched_version.name)},
        ${sql.identifier(security_findings.title.name)} = EXCLUDED.${sql.identifier(security_findings.title.name)},
        ${sql.identifier(security_findings.description.name)} = EXCLUDED.${sql.identifier(security_findings.description.name)},
        ${sql.identifier(security_findings.status.name)} = CASE
          WHEN ${security_findings.ignored_reason} LIKE 'superseded:%' THEN ${security_findings.status}
          ELSE EXCLUDED.${sql.identifier(security_findings.status.name)}
        END,
        ${sql.identifier(security_findings.ignored_reason.name)} = CASE
          WHEN ${security_findings.ignored_reason} LIKE 'superseded:%' THEN ${security_findings.ignored_reason}
          ELSE EXCLUDED.${sql.identifier(security_findings.ignored_reason.name)}
        END,
        ${sql.identifier(security_findings.ignored_by.name)} = CASE
          WHEN ${security_findings.ignored_reason} LIKE 'superseded:%' THEN ${security_findings.ignored_by}
          ELSE EXCLUDED.${sql.identifier(security_findings.ignored_by.name)}
        END,
        ${sql.identifier(security_findings.fixed_at.name)} = EXCLUDED.${sql.identifier(security_findings.fixed_at.name)},
        ${sql.identifier(security_findings.sla_due_at.name)} = EXCLUDED.${sql.identifier(security_findings.sla_due_at.name)},
        ${sql.identifier(security_findings.dependabot_html_url.name)} = EXCLUDED.${sql.identifier(security_findings.dependabot_html_url.name)},
        ${sql.identifier(security_findings.raw_data.name)} = EXCLUDED.${sql.identifier(security_findings.raw_data.name)},
        ${sql.identifier(security_findings.cwe_ids.name)} = EXCLUDED.${sql.identifier(security_findings.cwe_ids.name)},
        ${sql.identifier(security_findings.cvss_score.name)} = EXCLUDED.${sql.identifier(security_findings.cvss_score.name)},
        ${sql.identifier(security_findings.dependency_scope.name)} = EXCLUDED.${sql.identifier(security_findings.dependency_scope.name)},
        ${sql.identifier(security_findings.last_synced_at.name)} = now(),
        ${sql.identifier(security_findings.updated_at.name)} = now()
      WHERE EXISTS (SELECT 1 FROM existing_match)
      RETURNING
        ${security_findings.id} AS id,
        (xmax = 0) AS was_inserted,
        ${security_findings.status} AS effective_status,
        ${security_findings.created_at} AS created_at
    )
    SELECT
      upserted.id AS "findingId",
      CASE
        WHEN upserted.was_inserted THEN NULL::text
        ELSE COALESCE(existing_match.previous_status, upserted.effective_status)
      END AS "previousStatus",
      upserted.effective_status AS "effectiveStatus",
      upserted.created_at AS "findingCreatedAt"
    FROM upserted
    LEFT JOIN existing_match ON existing_match.id = upserted.id
    LIMIT 1
  `);

  const upserted = result.rows[0];
  if (upserted) return upsertSecurityFindingResultSchema.parse(upserted);

  const fallback = await db.execute<Record<string, unknown>>(sql`
    SELECT
      ${security_findings.id} AS "findingId",
      ${security_findings.status} AS "previousStatus",
      ${security_findings.status} AS "effectiveStatus",
      ${security_findings.created_at} AS "findingCreatedAt"
    FROM ${security_findings}
    WHERE ${security_findings.repo_full_name} = ${repoFullName}
      AND ${security_findings.source} = ${finding.source}
      AND ${security_findings.source_id} = ${finding.source_id}
    LIMIT 1
  `);
  const recovered = fallback.rows[0];
  if (!recovered) throw new Error('Failed to upsert security finding');
  return upsertSecurityFindingResultSchema.parse(recovered);
}

type AutoAnalysisQueueSyncResult = {
  enqueueCount: number;
  eligibleCount: number;
  boundarySkipCount: number;
  unknownSeverityCount: number;
};

const AUTO_ANALYSIS_REOPEN_REQUEUE_CAP = 2;
export function isFindingEligibleForAutoAnalysis(params: {
  findingCreatedAt: string;
  findingStatus: string;
  severity: string | null;
  ownerAutoAnalysisEnabledAt: string | null;
  isAgentEnabled: boolean;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
  autoAnalysisIncludeExisting?: boolean;
}): { eligible: boolean; severityRank: number } {
  const decision = decideAutoAnalysisEligibility({
    findingCreatedAt: params.findingCreatedAt,
    findingStatus: params.findingStatus,
    findingSeverity: params.severity,
    autoAnalysisEnabledAt: params.ownerAutoAnalysisEnabledAt,
    isAgentEnabled: params.isAgentEnabled,
    autoAnalysisEnabled: params.autoAnalysisEnabled,
    autoAnalysisMinSeverity: params.autoAnalysisMinSeverity,
    autoAnalysisIncludeExisting: params.autoAnalysisIncludeExisting,
  });

  return { eligible: decision.eligible, severityRank: decision.severityRank };
}

export async function syncAutoAnalysisQueueForFinding(
  db: WorkerDb,
  params: {
    owner: SecurityReviewOwner;
    findingId: string;
    findingCreatedAt: string;
    previousStatus: SecurityFindingStatus | null;
    currentStatus: SecurityFindingStatus;
    severity: string | null;
    isAgentEnabled: boolean;
    autoAnalysisEnabled: boolean;
    autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
    ownerAutoAnalysisEnabledAt: string | null;
    autoAnalysisIncludeExisting?: boolean;
  }
): Promise<AutoAnalysisQueueSyncResult> {
  const decision = decideAutoAnalysisEligibility({
    findingCreatedAt: params.findingCreatedAt,
    findingStatus: params.currentStatus,
    findingSeverity: params.severity,
    autoAnalysisEnabledAt: params.ownerAutoAnalysisEnabledAt,
    isAgentEnabled: params.isAgentEnabled,
    autoAnalysisEnabled: params.autoAnalysisEnabled,
    autoAnalysisMinSeverity: params.autoAnalysisMinSeverity,
    autoAnalysisIncludeExisting: params.autoAnalysisIncludeExisting,
  });
  const { eligible, severityRank } = decision;
  const boundarySkip = decision.boundarySkipped;
  const unknownSeverityCount = decision.severityWasUnknown ? 1 : 0;
  let enqueueCount = 0;
  const ownedByOrganizationId = isOrgOwner(params.owner) ? params.owner.organizationId : null;
  const ownedByUserId = isOrgOwner(params.owner) ? null : params.owner.userId;

  await db.transaction(async tx => {
    await tx
      .update(security_analysis_queue)
      .set({ severity_rank: severityRank, updated_at: sql`now()` })
      .where(
        and(
          eq(security_analysis_queue.finding_id, params.findingId),
          eq(security_analysis_queue.queue_status, 'queued')
        )
      );

    if (!eligible) {
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'completed',
          failure_code: 'SKIPPED_NO_LONGER_ELIGIBLE',
          claim_token: null,
          claimed_at: null,
          claimed_by_job_id: null,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            eq(security_analysis_queue.queue_status, 'queued')
          )
        );
    }

    const reopened =
      (params.previousStatus === SecurityFindingStatus.FIXED ||
        params.previousStatus === SecurityFindingStatus.IGNORED) &&
      params.currentStatus === SecurityFindingStatus.OPEN;
    if (reopened && eligible) {
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'queued',
          queued_at: sql`now()`,
          attempt_count: 0,
          next_retry_at: null,
          failure_code: null,
          last_error_redacted: null,
          claimed_at: null,
          claimed_by_job_id: null,
          claim_token: null,
          reopen_requeue_count: sql`${security_analysis_queue.reopen_requeue_count} + 1`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            or(
              eq(security_analysis_queue.queue_status, 'completed'),
              eq(security_analysis_queue.queue_status, 'failed')
            ),
            sql`${security_analysis_queue.reopen_requeue_count} < ${AUTO_ANALYSIS_REOPEN_REQUEUE_CAP}`
          )
        );
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'failed',
          failure_code: 'REOPEN_LOOP_GUARD',
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(security_analysis_queue.finding_id, params.findingId),
            or(
              eq(security_analysis_queue.queue_status, 'completed'),
              eq(security_analysis_queue.queue_status, 'failed')
            ),
            sql`${security_analysis_queue.reopen_requeue_count} >= ${AUTO_ANALYSIS_REOPEN_REQUEUE_CAP}`
          )
        );
    }

    if (eligible) {
      const inserted = await tx
        .insert(security_analysis_queue)
        .values({
          finding_id: params.findingId,
          owned_by_organization_id: ownedByOrganizationId,
          owned_by_user_id: ownedByUserId,
          queue_status: 'queued',
          severity_rank: severityRank,
          queued_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .onConflictDoNothing()
        .returning({ id: security_analysis_queue.id });
      enqueueCount = inserted.length;
    }
  });

  return {
    enqueueCount,
    eligibleCount: eligible ? 1 : 0,
    boundarySkipCount: boundarySkip ? 1 : 0,
    unknownSeverityCount,
  };
}

type SupersedeResult = { count: number; supersededFindingIds: string[] };

async function supersedeDuplicateFindings(
  db: WorkerDb,
  repoFullName: string
): Promise<SupersedeResult> {
  try {
    const result = await db.execute<{ id: string }>(sql`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY repo_full_name, source, ghsa_id, package_name, manifest_path
            ORDER BY CASE WHEN source_id ~ '^[0-9]+$' THEN source_id::int ELSE 0 END DESC
          ) AS rn,
          FIRST_VALUE(id) OVER (
            PARTITION BY repo_full_name, source, ghsa_id, package_name, manifest_path
            ORDER BY CASE WHEN source_id ~ '^[0-9]+$' THEN source_id::int ELSE 0 END DESC
          ) AS canonical_id
        FROM security_findings
        WHERE repo_full_name = ${repoFullName}
          AND source = 'dependabot'
          AND ghsa_id IS NOT NULL
          AND status = 'open'
      ),
      superseded AS (
        UPDATE security_findings
        SET
          status = 'ignored',
          ignored_reason = 'superseded:' || ranked.canonical_id,
          ignored_by = 'system',
          updated_at = now()
        FROM ranked
        WHERE security_findings.id = ranked.id
          AND ranked.rn > 1
        RETURNING security_findings.id
      )
      SELECT id FROM superseded
    `);
    const supersededFindingIds = result.rows.map(r => r.id);
    return { count: supersededFindingIds.length, supersededFindingIds };
  } catch (error) {
    // Best-effort: don't let dedup failures break the sync.
    console.error(`Error superseding duplicate findings for ${repoFullName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { count: 0, supersededFindingIds: [] };
  }
}

/**
 * Remove superseded findings from the auto-analysis queue so the worker
 * doesn't analyze findings that are no longer open.
 *
 * Clears `analysis_status` for `pending` findings so they no longer count
 * against the owner's concurrency cap. Already-running analyses are left
 * alone — the callback route transitions their queue rows when the job
 * reports back, releasing the concurrency slot at that point.
 */
async function dequeueSupersededFindings(db: WorkerDb, findingIds: string[]): Promise<number> {
  if (findingIds.length === 0) return 0;

  try {
    const result = await db
      .update(security_analysis_queue)
      .set({
        queue_status: 'completed',
        failure_code: 'SKIPPED_NO_LONGER_ELIGIBLE',
        claim_token: null,
        claimed_at: null,
        claimed_by_job_id: null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          inArray(security_analysis_queue.finding_id, findingIds),
          or(
            eq(security_analysis_queue.queue_status, 'queued'),
            eq(security_analysis_queue.queue_status, 'pending')
          )
        )
      )
      .returning({ id: security_analysis_queue.id });

    // Clear pending analysis_status so countRunningAnalyses no longer counts
    // these superseded findings against the owner's concurrency cap.
    // Running analyses are left alone — the callback route transitions their
    // queue rows when the job completes, releasing the concurrency slot.
    await db
      .update(security_findings)
      .set({
        analysis_status: null,
        updated_at: sql`now()`,
      })
      .where(
        and(
          inArray(security_findings.id, findingIds),
          eq(security_findings.analysis_status, 'pending')
        )
      );

    return result.length;
  } catch (error) {
    console.error('Error dequeuing superseded findings from analysis queue', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function writeAuditLog(
  db: WorkerDb,
  params: {
    owner: SecurityReviewOwner;
    actor?: { id: string; email?: string | null; name?: string | null };
    action: SecurityAuditLogAction;
    resource_type: string;
    resource_id: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const { owner, actor, action, resource_type, resource_id, metadata } = params;

  await db.insert(security_audit_log).values({
    owned_by_organization_id: isOrgOwner(owner) ? owner.organizationId : null,
    owned_by_user_id: isOrgOwner(owner) ? null : owner.userId,
    actor_id: actor?.id ?? null,
    actor_email: actor?.email ?? null,
    actor_name: actor?.name ?? null,
    action,
    resource_type,
    resource_id,
    metadata,
  });
}

async function pruneStaleReposFromConfig(
  db: WorkerDb,
  owner: SecurityReviewOwner,
  staleRepoNames: string[],
  repoNameToId: Map<string, number>
): Promise<void> {
  if (staleRepoNames.length === 0) return;

  const staleIds = new Set(
    staleRepoNames.map(name => repoNameToId.get(name)).filter((id): id is number => id != null)
  );
  if (staleIds.size === 0) return;

  const rows = await db
    .select({
      id: agent_configs.id,
      config: agent_configs.config,
      is_enabled: agent_configs.is_enabled,
    })
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.agent_type, 'security_scan'),
        eq(agent_configs.platform, 'github'),
        ownerFilter(owner)
      )
    )
    .limit(1);

  if (rows.length === 0) return;

  const parsed = securityAgentConfigSchema.partial().safeParse(rows[0].config);
  if (!parsed.success) {
    console.warn('Invalid security agent config, skipping prune', { error: parsed.error.message });
    return;
  }
  const config = parsed.data;
  if (
    config.repository_selection_mode !== 'selected' ||
    !config.selected_repository_ids ||
    config.selected_repository_ids.length === 0
  ) {
    return;
  }

  const prunedIds = config.selected_repository_ids.filter(id => !staleIds.has(id));
  if (prunedIds.length === config.selected_repository_ids.length) return;

  const updatedConfig = { ...config, selected_repository_ids: prunedIds };
  await db
    .update(agent_configs)
    .set({ config: updatedConfig, updated_at: sql`now()` })
    .where(eq(agent_configs.id, rows[0].id));

  console.warn(
    `Pruned ${config.selected_repository_ids.length - prunedIds.length} stale repo(s) from config`
  );
}

/** Remove selected_repository_ids that are no longer accessible via the GitHub installation.
 *  Unlike pruneStaleReposFromConfig (which prunes by repo name after sync), this handles
 *  repos that silently vanished from the installation and were never synced at all. */
async function pruneMissingSelectedRepos(
  db: WorkerDb,
  owner: SecurityReviewOwner,
  accessibleRepoIds: Set<number>
): Promise<void> {
  const rows = await db
    .select({
      id: agent_configs.id,
      config: agent_configs.config,
    })
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.agent_type, 'security_scan'),
        eq(agent_configs.platform, 'github'),
        ownerFilter(owner)
      )
    )
    .limit(1);

  if (rows.length === 0) return;

  const parsed = securityAgentConfigSchema.partial().safeParse(rows[0].config);
  if (!parsed.success) return;
  const config = parsed.data;

  if (
    config.repository_selection_mode !== 'selected' ||
    !config.selected_repository_ids ||
    config.selected_repository_ids.length === 0
  ) {
    return;
  }

  const prunedIds = config.selected_repository_ids.filter(id => accessibleRepoIds.has(id));
  if (prunedIds.length === config.selected_repository_ids.length) return;

  const removedCount = config.selected_repository_ids.length - prunedIds.length;
  const updatedConfig = { ...config, selected_repository_ids: prunedIds };
  await db
    .update(agent_configs)
    .set({ config: updatedConfig, updated_at: sql`now()` })
    .where(eq(agent_configs.id, rows[0].id));

  console.warn(`Pruned ${removedCount} inaccessible repo ID(s) from config`);
}

export function selectRepositoriesForSync(
  config: Pick<EnabledOwnerConfig, 'repositories' | 'repoNameToId'>,
  repoFullName?: string
): string[] {
  if (!repoFullName) return config.repositories;
  return config.repoNameToId.has(repoFullName) ? [repoFullName] : [];
}

export async function syncOwner(params: {
  db: WorkerDb;
  gitTokenService: GitTokenService;
  owner: SecurityReviewOwner;
  runId: string;
  trigger?: 'scheduled' | 'manual';
  actor?: { id: string; email?: string | null; name?: string | null };
  repoFullName?: string;
}): Promise<SyncResult> {
  const { db: database, gitTokenService, owner, runId, actor, repoFullName } = params;
  const trigger = params.trigger ?? 'scheduled';
  const startTime = Date.now();

  const config = await getOwnerConfig(database, owner);
  if (!config) {
    console.info(`No enabled config for owner, skipping`, { runId, owner });
    return createEmptySyncResult();
  }

  const repositories = selectRepositoriesForSync(config, repoFullName);
  if (repoFullName && repositories.length === 0) {
    console.warn('Manual sync repository is not accessible for owner, skipping', {
      runId,
      owner,
      repoFullName,
    });
    return createEmptySyncResult();
  }

  if (isRecentTimestamp(config.authInvalidAt, AUTH_INVALID_SHORT_CIRCUIT_MS)) {
    console.warn('Skipping security sync because GitHub installation needs reauthorization', {
      runId,
      owner,
      repositoryCount: repositories.length,
      authInvalidAt: config.authInvalidAt,
    });
    return createAuthInvalidSyncResult(repositories);
  }

  const totalResult = createEmptySyncResult();
  let firstError: Error | null = null;
  let successfulRepos = 0;

  for (const repoFullName of repositories) {
    try {
      const repoResult = await syncRepo({
        db: database,
        gitTokenService,
        installationId: config.installationId,
        owner,
        platformIntegrationId: config.platformIntegrationId,
        repoFullName,
        slaConfig: config.slaConfig,
        autoAnalysisEnabledAt: config.autoAnalysisEnabledAt,
      });
      totalResult.synced += repoResult.synced;
      totalResult.errors += repoResult.errors;
      totalResult.skipped += repoResult.skipped;
      totalResult.authInvalid += repoResult.authInvalid;
      totalResult.authInvalidRepos.push(...repoResult.authInvalidRepos);
      totalResult.reauthRequired = totalResult.reauthRequired || repoResult.reauthRequired;
      totalResult.staleRepos.push(...repoResult.staleRepos);
      successfulRepos++;

      if (repoResult.reauthRequired) {
        break;
      }
    } catch (error) {
      totalResult.errors++;
      console.error(`Failed to sync ${repoFullName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!firstError && error instanceof Error) {
        firstError = error;
      }
    }
  }

  if (successfulRepos === 0 && firstError) {
    throw firstError;
  }

  // Prune stale configured repositories regardless of trigger so manual and scheduled
  // sync do not disagree about owner configuration after GitHub reports permanent loss.
  if (totalResult.staleRepos.length > 0) {
    try {
      await pruneStaleReposFromConfig(database, owner, totalResult.staleRepos, config.repoNameToId);
    } catch (error) {
      console.error('Failed to prune stale repos from config', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Prune selected repo IDs that silently vanished from the installation. Owner config
  // inspection already loaded full accessible repositories for both sync scopes.
  if (config.missingSelectedRepoCount > 0) {
    try {
      const accessibleRepoIds = new Set(config.repoNameToId.values());
      await pruneMissingSelectedRepos(database, owner, accessibleRepoIds);
    } catch (error) {
      console.error('Failed to prune missing selected repos from config', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Write audit log
  const ownerId =
    'organizationId' in owner ? (owner.organizationId ?? 'unknown') : (owner.userId ?? 'unknown');
  try {
    await writeAuditLog(database, {
      owner,
      actor,
      action: SecurityAuditLogAction.SyncCompleted,
      resource_type: 'agent_config',
      resource_id: ownerId,
      metadata: {
        source: trigger === 'manual' ? 'user' : 'system',
        trigger,
        runId,
        repoFullName,
        synced: totalResult.synced,
        errors: totalResult.errors,
        authInvalidRepos: totalResult.authInvalidRepos,
        reauthRequired: totalResult.reauthRequired,
        repoCount: repositories.length,
      },
    });
  } catch (error) {
    console.error('Failed to write audit log', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Only advance owner-level freshness when every repo was actually synced.
  // Stale repos (deleted/transferred/access-blocked) block the update because
  // they were selected for sync but never refreshed.  Skipped repos
  // (Dependabot permanently disabled) do NOT block — that's a permanent
  // repo-level setting, and blocking here would leave the timestamp stuck.
  // Missing selected repos (installation lost access) also block — the repo
  // was configured but silently dropped from the accessible list.
  if (
    !repoFullName &&
    totalResult.errors === 0 &&
    totalResult.authInvalid === 0 &&
    totalResult.staleRepos.length === 0 &&
    config.missingSelectedRepoCount === 0
  ) {
    try {
      await database
        .update(agent_configs)
        .set({
          runtime_state: sql`jsonb_set(
            COALESCE(${agent_configs.runtime_state}, '{}'::jsonb),
            '{last_synced_at}',
            to_jsonb(now())
          )`,
        })
        .where(
          and(
            eq(agent_configs.agent_type, 'security_scan'),
            eq(agent_configs.platform, 'github'),
            ownerFilter(owner)
          )
        );
    } catch (error) {
      console.error('Failed to update last_synced_at in runtime_state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const syncSummary = {
    runId,
    ownerId,
    reposScanned: repositories.length,
    findingsSynced: totalResult.synced,
    errors: totalResult.errors,
    skippedRepos: totalResult.skipped,
    authInvalidRepos: totalResult.authInvalidRepos,
    reauthRequired: totalResult.reauthRequired,
    staleRepos: totalResult.staleRepos,
    missingSelectedRepos: config.missingSelectedRepoCount,
    durationMs: Date.now() - startTime,
  };

  if (
    totalResult.synced === 0 &&
    totalResult.errors === 0 &&
    totalResult.skipped === 0 &&
    totalResult.authInvalid === 0
  ) {
    console.warn('Sync completed with zero findings processed across all repos', syncSummary);
  } else {
    console.info('Sync cycle summary', syncSummary);
  }

  return totalResult;
}

async function syncRepo(params: {
  db: WorkerDb;
  gitTokenService: GitTokenService;
  installationId: string;
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  repoFullName: string;
  slaConfig: SecurityAgentConfig;
  autoAnalysisEnabledAt: string | null;
}): Promise<SyncResult> {
  const {
    db: database,
    gitTokenService,
    installationId,
    owner,
    platformIntegrationId,
    repoFullName,
    slaConfig,
  } = params;
  const token = await gitTokenService.getToken(installationId);
  const result = createEmptySyncResult();

  const [repoOwner, repoName] = repoFullName.split('/');
  if (!repoOwner || !repoName) {
    throw new Error(`Invalid repo full name: ${repoFullName}`);
  }

  const fetchResult = await fetchAllDependabotAlerts(token, repoOwner, repoName);

  if (fetchResult.status === 'auth_invalid') {
    console.warn('GitHub installation needs reauthorization; skipping repo sync', {
      platformIntegrationId,
      installationId,
      repoFullName,
    });
    await markIntegrationAuthInvalid(database, platformIntegrationId);
    return createAuthInvalidSyncResult([repoFullName]);
  }

  if (fetchResult.status === 'repo_not_found') {
    console.warn(`Repository ${repoFullName} no longer exists, marking as stale`);
    result.staleRepos.push(repoFullName);
    return result;
  }

  if (fetchResult.status === 'alerts_disabled') {
    console.info(`Dependabot alerts disabled for ${repoFullName}, skipping`);
    result.skipped = 1;
    return result;
  }

  if (fetchResult.status === 'access_blocked') {
    console.warn(`Repository ${repoFullName} access blocked, marking as stale`);
    result.staleRepos.push(repoFullName);
    return result;
  }

  await clearIntegrationAuthInvalid(database, platformIntegrationId);

  const findings = fetchResult.alerts.map(alert => parseDependabotAlert(alert));
  console.info(`Fetched ${fetchResult.alerts.length} alerts, parsed ${findings.length} findings`, {
    repo: repoFullName,
  });

  for (const finding of findings) {
    try {
      const slaDays = getSlaForSeverity(slaConfig, finding.severity);
      const slaDueAt = calculateSlaDueAt(finding.first_detected_at, slaDays);

      const upserted = await upsertSecurityFinding(database, {
        finding,
        owner,
        platformIntegrationId,
        repoFullName,
        slaDueAt,
      });
      await syncAutoAnalysisQueueForFinding(database, {
        owner,
        findingId: upserted.findingId,
        findingCreatedAt: upserted.findingCreatedAt,
        previousStatus: upserted.previousStatus,
        currentStatus: upserted.effectiveStatus,
        severity: finding.severity,
        isAgentEnabled: true,
        autoAnalysisEnabled: slaConfig.auto_analysis_enabled,
        autoAnalysisMinSeverity: slaConfig.auto_analysis_min_severity,
        ownerAutoAnalysisEnabledAt: params.autoAnalysisEnabledAt,
        autoAnalysisIncludeExisting: slaConfig.auto_analysis_include_existing,
      });
      result.synced++;
    } catch (error) {
      result.errors++;
      console.error(`Error upserting finding for ${repoFullName}`, {
        alertNumber: finding.source_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { count: supersededCount, supersededFindingIds } = await supersedeDuplicateFindings(
    database,
    repoFullName
  );
  if (supersededCount > 0) {
    console.info(`Superseded ${supersededCount} duplicate finding(s) for ${repoFullName}`);
    const dequeued = await dequeueSupersededFindings(database, supersededFindingIds);
    if (dequeued > 0) {
      console.info(`Dequeued ${dequeued} superseded finding(s) from auto-analysis queue`);
    }
  }

  return result;
}
