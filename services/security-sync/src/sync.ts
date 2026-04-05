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
  security_audit_log,
} from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';

const SecurityFindingSource = { DEPENDABOT: 'dependabot' } as const;

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
    cvss: z.object({ score: z.number(), vector_string: z.string() }).optional(),
    cwes: z.array(z.object({ cwe_id: z.string(), name: z.string() })).optional(),
  }),
  security_vulnerability: z.object({
    vulnerable_version_range: z.string(),
    first_patched_version: z.object({ identifier: z.string() }).optional(),
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
};

const securityAgentConfigSchema = z.object({
  sla_critical_days: z.number(),
  sla_high_days: z.number(),
  sla_medium_days: z.number(),
  sla_low_days: z.number(),
  repository_selection_mode: z.enum(['all', 'selected']),
  selected_repository_ids: z.array(z.number()).optional(),
});

const DEFAULT_SLA_CONFIG: SecurityAgentConfig = {
  sla_critical_days: 15,
  sla_high_days: 30,
  sla_medium_days: 45,
  sla_low_days: 90,
  repository_selection_mode: 'all',
};

type SecurityReviewOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type SyncResult = {
  synced: number;
  errors: number;
  /** Repos where Dependabot alerts are permanently disabled (safe to skip) */
  skipped: number;
  /** Repos that returned 404 or are access-blocked (deleted/transferred/inaccessible) */
  staleRepos: string[];
};

type FetchAlertsResult =
  | { status: 'success'; alerts: DependabotAlertRaw[] }
  | { status: 'repo_not_found' }
  | { status: 'alerts_disabled' }
  | { status: 'access_blocked' };

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

type EnabledOwnerConfig = {
  owner: SecurityReviewOwner;
  platformIntegrationId: string;
  installationId: string;
  repositories: string[];
  repoNameToId: Map<string, number>;
  slaConfig: SecurityAgentConfig;
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

  return {
    owner,
    platformIntegrationId: integration.id,
    installationId: integration.platform_installation_id,
    repositories: selectedRepos,
    repoNameToId,
    slaConfig: { ...DEFAULT_SLA_CONFIG, ...securityConfig },
    missingSelectedRepoCount,
  };
}

async function fetchAllDependabotAlerts(
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

async function upsertSecurityFinding(
  db: WorkerDb,
  params: {
    finding: ParsedSecurityFinding;
    owner: SecurityReviewOwner;
    platformIntegrationId: string;
    repoFullName: string;
    slaDueAt: string;
  }
): Promise<void> {
  const { finding, owner, platformIntegrationId, repoFullName, slaDueAt } = params;

  // Fields that are updated on conflict (shared between insert and upsert).
  // status, ignored_reason, and ignored_by are excluded here because the
  // ON CONFLICT clause needs conditional logic to preserve superseded state.
  const mutableFields = {
    severity: finding.severity,
    ghsa_id: finding.ghsa_id,
    cve_id: finding.cve_id,
    vulnerable_version_range: finding.vulnerable_version_range,
    patched_version: finding.patched_version,
    title: finding.title,
    description: finding.description,
    fixed_at: finding.fixed_at,
    sla_due_at: slaDueAt,
    dependabot_html_url: finding.dependabot_html_url,
    raw_data: finding.raw_data,
    cwe_ids: finding.cwe_ids,
    cvss_score: finding.cvss_score?.toString() ?? null,
    dependency_scope: finding.dependency_scope,
  };

  await db
    .insert(security_findings)
    .values({
      owned_by_organization_id: isOrgOwner(owner) ? owner.organizationId : null,
      owned_by_user_id: isOrgOwner(owner) ? null : owner.userId,
      platform_integration_id: platformIntegrationId,
      repo_full_name: repoFullName,
      source: finding.source,
      source_id: finding.source_id,
      package_name: finding.package_name,
      package_ecosystem: finding.package_ecosystem,
      manifest_path: finding.manifest_path,
      first_detected_at: finding.first_detected_at,
      status: finding.status,
      ignored_reason: finding.ignored_reason,
      ignored_by: finding.ignored_by,
      ...mutableFields,
    })
    .onConflictDoUpdate({
      target: [
        security_findings.repo_full_name,
        security_findings.source,
        security_findings.source_id,
      ],
      set: {
        ...mutableFields,
        status: sql`CASE WHEN ${security_findings.ignored_reason} LIKE 'superseded:%' THEN ${security_findings.status} ELSE ${finding.status} END`,
        ignored_reason: sql`CASE WHEN ${security_findings.ignored_reason} LIKE 'superseded:%' THEN ${security_findings.ignored_reason} ELSE ${finding.ignored_reason} END`,
        ignored_by: sql`CASE WHEN ${security_findings.ignored_reason} LIKE 'superseded:%' THEN ${security_findings.ignored_by} ELSE ${finding.ignored_by} END`,
        last_synced_at: sql`now()`,
        updated_at: sql`now()`,
      },
    });
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
    action: SecurityAuditLogAction;
    resource_type: string;
    resource_id: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const { owner, action, resource_type, resource_id, metadata } = params;

  await db.insert(security_audit_log).values({
    owned_by_organization_id: isOrgOwner(owner) ? owner.organizationId : null,
    owned_by_user_id: isOrgOwner(owner) ? null : owner.userId,
    actor_id: null,
    actor_email: null,
    actor_name: null,
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

export async function syncOwner(params: {
  db: WorkerDb;
  gitTokenService: GitTokenService;
  owner: SecurityReviewOwner;
  runId: string;
}): Promise<SyncResult> {
  const { db: database, gitTokenService, owner, runId } = params;
  const startTime = Date.now();

  const config = await getOwnerConfig(database, owner);
  if (!config) {
    console.info(`No enabled config for owner, skipping`, { runId, owner });
    return { synced: 0, errors: 0, skipped: 0, staleRepos: [] };
  }

  const totalResult: SyncResult = { synced: 0, errors: 0, skipped: 0, staleRepos: [] };
  let firstError: Error | null = null;
  let successfulRepos = 0;

  for (const repoFullName of config.repositories) {
    try {
      const repoResult = await syncRepo({
        db: database,
        gitTokenService,
        installationId: config.installationId,
        owner,
        platformIntegrationId: config.platformIntegrationId,
        repoFullName,
        slaConfig: config.slaConfig,
      });
      totalResult.synced += repoResult.synced;
      totalResult.errors += repoResult.errors;
      totalResult.skipped += repoResult.skipped;
      totalResult.staleRepos.push(...repoResult.staleRepos);
      successfulRepos++;
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

  // Prune stale repos
  if (totalResult.staleRepos.length > 0) {
    try {
      await pruneStaleReposFromConfig(database, owner, totalResult.staleRepos, config.repoNameToId);
    } catch (error) {
      console.error('Failed to prune stale repos from config', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Prune selected repo IDs that silently vanished from the installation
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
      action: SecurityAuditLogAction.SyncCompleted,
      resource_type: 'agent_config',
      resource_id: ownerId,
      metadata: {
        source: 'system',
        trigger: 'worker_queue',
        runId,
        synced: totalResult.synced,
        errors: totalResult.errors,
        repoCount: config.repositories.length,
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
    totalResult.errors === 0 &&
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
    reposScanned: config.repositories.length,
    findingsSynced: totalResult.synced,
    errors: totalResult.errors,
    skippedRepos: totalResult.skipped,
    staleRepos: totalResult.staleRepos,
    missingSelectedRepos: config.missingSelectedRepoCount,
    durationMs: Date.now() - startTime,
  };

  if (totalResult.synced === 0 && totalResult.errors === 0 && totalResult.skipped === 0) {
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
  const result: SyncResult = { synced: 0, errors: 0, skipped: 0, staleRepos: [] };

  const [repoOwner, repoName] = repoFullName.split('/');
  if (!repoOwner || !repoName) {
    throw new Error(`Invalid repo full name: ${repoFullName}`);
  }

  const fetchResult = await fetchAllDependabotAlerts(token, repoOwner, repoName);

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

  const findings = fetchResult.alerts.map(alert => parseDependabotAlert(alert));
  console.info(`Fetched ${fetchResult.alerts.length} alerts, parsed ${findings.length} findings`, {
    repo: repoFullName,
  });

  for (const finding of findings) {
    try {
      const slaDays = getSlaForSeverity(slaConfig, finding.severity);
      const slaDueAt = calculateSlaDueAt(finding.first_detected_at, slaDays);

      await upsertSecurityFinding(database, {
        finding,
        owner,
        platformIntegrationId,
        repoFullName,
        slaDueAt,
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
