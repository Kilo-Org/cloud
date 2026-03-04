import type { WorkerDb } from '@kilocode/db/client';
import {
  security_analysis_queue,
  security_analysis_owner_state,
  security_findings,
  agent_configs,
  kilocode_users,
  organization_memberships,
} from '@kilocode/db/schema';
import { and, asc, count, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { QueueOwner, SecurityAgentConfig, SecurityFindingAnalysis } from '../types.js';
import {
  AUTO_ANALYSIS_OWNER_CAP,
  DEFAULT_SECURITY_AGENT_CONFIG,
  SecurityAgentConfigSchema,
  SECURITY_ANALYSIS_OWNER_CAP,
} from '../types.js';

export type ClaimedQueueRow = {
  id: string;
  finding_id: string;
  claim_token: string;
  attempt_count: number;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
};

export type ActorUser = {
  id: string;
  api_token_pepper: string | null;
};

type ClaimRowsForOwnerResult = {
  rows: ClaimedQueueRow[];
  config: SecurityAgentConfig;
  isAgentEnabled: boolean;
  autoAnalysisEnabledAt: string | null;
  blocked: boolean;
};

function parseSecurityConfig(config: unknown): SecurityAgentConfig {
  let configValue: unknown = config;

  if (typeof configValue === 'string') {
    try {
      configValue = JSON.parse(configValue);
    } catch {
      configValue = {};
    }
  }

  const parsed = SecurityAgentConfigSchema.partial().safeParse(configValue ?? {});
  if (!parsed.success) {
    return DEFAULT_SECURITY_AGENT_CONFIG;
  }

  return {
    ...DEFAULT_SECURITY_AGENT_CONFIG,
    ...parsed.data,
  };
}

function ownerWhereQueue(owner: QueueOwner) {
  return owner.type === 'org'
    ? eq(security_analysis_queue.owned_by_organization_id, owner.id)
    : eq(security_analysis_queue.owned_by_user_id, owner.id);
}

function ownerWhereFindings(owner: QueueOwner) {
  return owner.type === 'org'
    ? eq(security_findings.owned_by_organization_id, owner.id)
    : eq(security_findings.owned_by_user_id, owner.id);
}

function ownerWhereOwnerState(owner: QueueOwner) {
  return owner.type === 'org'
    ? eq(security_analysis_owner_state.owned_by_organization_id, owner.id)
    : eq(security_analysis_owner_state.owned_by_user_id, owner.id);
}

export async function discoverDueOwners(db: WorkerDb, limit: number): Promise<QueueOwner[]> {
  const rows = await db
    .selectDistinct({
      owned_by_organization_id: security_analysis_queue.owned_by_organization_id,
      owned_by_user_id: security_analysis_queue.owned_by_user_id,
    })
    .from(security_analysis_queue)
    .leftJoin(
      security_analysis_owner_state,
      or(
        and(
          sql`${security_analysis_queue.owned_by_organization_id} IS NOT NULL`,
          eq(
            security_analysis_queue.owned_by_organization_id,
            security_analysis_owner_state.owned_by_organization_id
          )
        ),
        and(
          sql`${security_analysis_queue.owned_by_user_id} IS NOT NULL`,
          eq(
            security_analysis_queue.owned_by_user_id,
            security_analysis_owner_state.owned_by_user_id
          )
        )
      )
    )
    .where(
      and(
        eq(security_analysis_queue.queue_status, 'queued'),
        lte(
          sql`coalesce(${security_analysis_queue.next_retry_at}, '-infinity'::timestamptz)`,
          sql`now()`
        ),
        or(
          isNull(security_analysis_owner_state.blocked_until),
          lte(security_analysis_owner_state.blocked_until, sql`now()`)
        )
      )
    )
    .orderBy(
      asc(security_analysis_queue.owned_by_organization_id),
      asc(security_analysis_queue.owned_by_user_id)
    )
    .limit(limit);

  const owners: QueueOwner[] = [];
  for (const row of rows) {
    if (row.owned_by_organization_id) {
      owners.push({ type: 'org', id: row.owned_by_organization_id });
    } else if (row.owned_by_user_id) {
      owners.push({ type: 'user', id: row.owned_by_user_id });
    }
  }
  return owners;
}

export async function claimRowsForOwner(
  db: WorkerDb,
  params: { owner: QueueOwner; jobId: string; maxPerOwner: number }
): Promise<ClaimRowsForOwnerResult> {
  const orgId = params.owner.type === 'org' ? params.owner.id : null;
  const userId = params.owner.type === 'user' ? params.owner.id : null;

  return db.transaction(async tx => {
    await tx
      .insert(security_analysis_owner_state)
      .values({
        owned_by_organization_id: orgId,
        owned_by_user_id: userId,
      })
      .onConflictDoNothing();

    const stateRows = await tx
      .select({
        blocked_until: security_analysis_owner_state.blocked_until,
        auto_analysis_enabled_at: security_analysis_owner_state.auto_analysis_enabled_at,
      })
      .from(security_analysis_owner_state)
      .where(ownerWhereOwnerState(params.owner))
      .for('update')
      .limit(1);

    const state = stateRows[0] ?? { blocked_until: null, auto_analysis_enabled_at: null };

    const blocked =
      state.blocked_until !== null && Number.isFinite(Date.parse(state.blocked_until))
        ? Date.parse(state.blocked_until) > Date.now()
        : false;

    const configRows = await tx
      .select({
        config: agent_configs.config,
        is_enabled: agent_configs.is_enabled,
      })
      .from(agent_configs)
      .where(
        and(
          eq(agent_configs.agent_type, 'security_scan'),
          eq(agent_configs.platform, 'github'),
          params.owner.type === 'org'
            ? eq(agent_configs.owned_by_organization_id, params.owner.id)
            : eq(agent_configs.owned_by_user_id, params.owner.id)
        )
      )
      .limit(1);

    const parsedConfig = parseSecurityConfig(configRows[0]?.config);
    const isAgentEnabled = configRows[0]?.is_enabled ?? false;

    const emptyResult: ClaimRowsForOwnerResult = {
      rows: [],
      config: parsedConfig,
      isAgentEnabled,
      autoAnalysisEnabledAt: state.auto_analysis_enabled_at,
      blocked,
    };

    if (!isAgentEnabled || !parsedConfig.auto_analysis_enabled || blocked) {
      return emptyResult;
    }

    const [totalInflightResult] = await tx
      .select({ total: count() })
      .from(security_findings)
      .where(
        and(
          ownerWhereFindings(params.owner),
          inArray(security_findings.analysis_status, ['pending', 'running'])
        )
      );

    const [autoInflightResult] = await tx
      .select({ total: count() })
      .from(security_analysis_queue)
      .where(
        and(
          ownerWhereQueue(params.owner),
          inArray(security_analysis_queue.queue_status, ['pending', 'running'])
        )
      );

    const totalInflight = totalInflightResult?.total ?? 0;
    const autoInflight = autoInflightResult?.total ?? 0;

    const availableByTotal = Math.max(0, SECURITY_ANALYSIS_OWNER_CAP - totalInflight);
    const availableByAuto = Math.max(0, AUTO_ANALYSIS_OWNER_CAP - autoInflight);
    const claimLimit = Math.min(params.maxPerOwner, availableByTotal, availableByAuto);

    if (claimLimit <= 0) {
      return emptyResult;
    }

    const claimedRows = await tx.execute<ClaimedQueueRow>(sql`
      UPDATE security_analysis_queue
      SET
        queue_status = 'pending',
        claimed_at = now(),
        claimed_by_job_id = ${params.jobId},
        claim_token = gen_random_uuid()::text,
        updated_at = now()
      WHERE id IN (
        SELECT id
        FROM security_analysis_queue
        WHERE queue_status = 'queued'
          AND ${
            params.owner.type === 'org'
              ? sql`owned_by_organization_id = ${orgId}::uuid`
              : sql`owned_by_user_id = ${userId}`
          }
          AND coalesce(next_retry_at, '-infinity'::timestamptz) <= now()
        ORDER BY severity_rank ASC, queued_at ASC, id ASC
        LIMIT ${claimLimit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        finding_id,
        claim_token,
        attempt_count,
        owned_by_organization_id::text,
        owned_by_user_id
    `);

    return {
      rows: claimedRows.rows,
      config: parsedConfig,
      isAgentEnabled,
      autoAnalysisEnabledAt: state.auto_analysis_enabled_at,
      blocked,
    };
  });
}

export async function updateQueueFromPending(
  db: WorkerDb,
  params: {
    rowId: string;
    claimToken: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    failureCode: string | null;
    errorMessage: string | null;
    incrementAttempt: boolean;
    nextRetryAt: string | null;
  }
): Promise<{ updated: boolean; attemptCount: number | null }> {
  const rows = await db.execute<{ attempt_count: number }>(sql`
    UPDATE security_analysis_queue
    SET
      queue_status = ${params.status},
      attempt_count = CASE
        WHEN ${params.incrementAttempt} THEN attempt_count + 1
        ELSE attempt_count
      END,
      failure_code = ${params.failureCode},
      last_error_redacted = ${params.errorMessage},
      next_retry_at = ${params.nextRetryAt},
      claimed_at = CASE
        WHEN ${params.status} = 'queued' THEN NULL
        ELSE claimed_at
      END,
      claimed_by_job_id = CASE
        WHEN ${params.status} = 'queued' THEN NULL
        ELSE claimed_by_job_id
      END,
      claim_token = CASE
        WHEN ${params.status} = 'queued' THEN NULL
        ELSE claim_token
      END,
      updated_at = now()
    WHERE id = ${params.rowId}::uuid
      AND queue_status = 'pending'
      AND claim_token = ${params.claimToken}
    RETURNING attempt_count
  `);

  const updatedRow = rows.rows[0];
  return {
    updated: updatedRow !== undefined,
    attemptCount: updatedRow?.attempt_count ?? null,
  };
}

export async function resolveAutoAnalysisActor(
  db: WorkerDb,
  owner: QueueOwner
): Promise<{ user: ActorUser; mode: 'owner' | 'member_fallback' } | null> {
  if (owner.type === 'user') {
    const rows = await db
      .select({
        id: kilocode_users.id,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(and(eq(kilocode_users.id, owner.id), isNull(kilocode_users.blocked_reason)))
      .limit(1);

    const user = rows[0];
    return user ? { user, mode: 'owner' } : null;
  }

  // Org: try owner first
  const ownerRows = await db
    .select({
      id: kilocode_users.id,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        eq(organization_memberships.role, 'owner'),
        isNull(kilocode_users.blocked_reason)
      )
    )
    .orderBy(asc(kilocode_users.created_at), asc(kilocode_users.id))
    .limit(1);

  const ownerUser = ownerRows[0];
  if (ownerUser) {
    return { user: ownerUser, mode: 'owner' };
  }

  // Org: fall back to first member
  const memberRows = await db
    .select({
      id: kilocode_users.id,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        eq(organization_memberships.role, 'member'),
        isNull(kilocode_users.blocked_reason)
      )
    )
    .orderBy(asc(kilocode_users.created_at), asc(kilocode_users.id))
    .limit(1);

  const memberUser = memberRows[0];
  return memberUser ? { user: memberUser, mode: 'member_fallback' } : null;
}

export async function markOwnerActorResolutionFailure(
  db: WorkerDb,
  owner: QueueOwner
): Promise<void> {
  await db
    .update(security_analysis_owner_state)
    .set({
      block_reason: 'ACTOR_RESOLUTION_FAILED',
      blocked_until: sql`now() + interval '30 minutes'`.mapWith(String),
      consecutive_actor_resolution_failures: sql`${security_analysis_owner_state.consecutive_actor_resolution_failures} + 1`,
      last_actor_resolution_failure_at: sql`now()`.mapWith(String),
    })
    .where(ownerWhereOwnerState(owner));
}

export async function clearOwnerActorResolutionFailure(
  db: WorkerDb,
  owner: QueueOwner
): Promise<void> {
  await db.execute(sql`
    UPDATE security_analysis_owner_state
    SET
      consecutive_actor_resolution_failures = 0,
      last_actor_resolution_failure_at = NULL,
      blocked_until = CASE
        WHEN block_reason = 'ACTOR_RESOLUTION_FAILED' THEN NULL
        ELSE blocked_until
      END,
      block_reason = CASE
        WHEN block_reason = 'ACTOR_RESOLUTION_FAILED' THEN NULL
        ELSE block_reason
      END,
      updated_at = now()
    WHERE ${ownerWhereOwnerState(owner)}
  `);
}

export async function markOwnerCreditFailure(db: WorkerDb, owner: QueueOwner): Promise<void> {
  await db
    .update(security_analysis_owner_state)
    .set({
      blocked_until: sql`now() + interval '30 minutes'`.mapWith(String),
      block_reason: 'INSUFFICIENT_CREDITS',
    })
    .where(ownerWhereOwnerState(owner));
}

export async function getSecurityFindingById(db: WorkerDb, findingId: string) {
  const rows = await db
    .select({
      id: security_findings.id,
      repo_full_name: security_findings.repo_full_name,
      created_at: security_findings.created_at,
      status: security_findings.status,
      severity: security_findings.severity,
      package_name: security_findings.package_name,
      package_ecosystem: security_findings.package_ecosystem,
      dependency_scope: security_findings.dependency_scope,
      cve_id: security_findings.cve_id,
      ghsa_id: security_findings.ghsa_id,
      title: security_findings.title,
      description: security_findings.description,
      vulnerable_version_range: security_findings.vulnerable_version_range,
      patched_version: security_findings.patched_version,
      manifest_path: security_findings.manifest_path,
      raw_data: security_findings.raw_data,
      analysis_status: security_findings.analysis_status,
      owned_by_organization_id: security_findings.owned_by_organization_id,
      owned_by_user_id: security_findings.owned_by_user_id,
    })
    .from(security_findings)
    .where(eq(security_findings.id, findingId))
    .limit(1);

  return rows[0] ?? null;
}

export type SecurityFindingRecord = NonNullable<Awaited<ReturnType<typeof getSecurityFindingById>>>;

export async function tryAcquireAnalysisStartLease(
  db: WorkerDb,
  findingId: string
): Promise<boolean> {
  const rows = await db
    .update(security_findings)
    .set({
      analysis_status: 'pending',
      updated_at: sql`now()`.mapWith(String),
    })
    .where(
      and(
        eq(security_findings.id, findingId),
        eq(security_findings.status, 'open'),
        or(
          isNull(security_findings.analysis_status),
          eq(security_findings.analysis_status, 'completed'),
          eq(security_findings.analysis_status, 'failed')
        )
      )
    )
    .returning({ id: security_findings.id });

  return rows.length > 0;
}

export async function setFindingPending(
  db: WorkerDb,
  findingId: string,
  analysis: SecurityFindingAnalysis | null
): Promise<void> {
  await db
    .update(security_findings)
    .set({
      analysis_status: 'pending',
      analysis_error: null,
      analysis: analysis ? sql`${JSON.stringify(analysis)}::jsonb` : null,
      analysis_completed_at: null,
      session_id: null,
      cli_session_id: null,
      updated_at: sql`now()`.mapWith(String),
    })
    .where(eq(security_findings.id, findingId));
}

export async function setFindingRunning(
  db: WorkerDb,
  findingId: string,
  cloudAgentSessionId: string,
  kiloSessionId: string
): Promise<void> {
  await db
    .update(security_findings)
    .set({
      analysis_status: 'running',
      session_id: cloudAgentSessionId,
      cli_session_id: kiloSessionId,
      analysis_started_at: sql`coalesce(${security_findings.analysis_started_at}, now())`.mapWith(
        String
      ),
      updated_at: sql`now()`.mapWith(String),
    })
    .where(eq(security_findings.id, findingId));
}

export async function setFindingCompleted(
  db: WorkerDb,
  findingId: string,
  analysis: SecurityFindingAnalysis
): Promise<void> {
  await db
    .update(security_findings)
    .set({
      analysis_status: 'completed',
      analysis: sql`${JSON.stringify(analysis)}::jsonb`,
      analysis_error: null,
      analysis_completed_at: sql`now()`.mapWith(String),
      updated_at: sql`now()`.mapWith(String),
    })
    .where(eq(security_findings.id, findingId));
}

export async function setFindingFailed(
  db: WorkerDb,
  findingId: string,
  errorMessage: string
): Promise<void> {
  await db
    .update(security_findings)
    .set({
      analysis_status: 'failed',
      analysis_error: errorMessage,
      analysis_completed_at: sql`now()`.mapWith(String),
      updated_at: sql`now()`.mapWith(String),
    })
    .where(eq(security_findings.id, findingId));
}
