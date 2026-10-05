import 'server-only';

import { randomUUID } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import { WorkOS } from '@workos-inc/node';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';

import { WORKOS_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import {
  organization_domain_claims,
  organizations,
  type OrganizationDomainClaim,
} from '@kilocode/db/schema';

const LOG_SOURCE = 'verified-domain-cleanup';
const AUDIT_ACTOR_NAME = 'verified-domain-cleanup';

export type CleanupProvider = {
  organizations: Pick<
    WorkOS['organizations'],
    'getOrganizationByExternalId' | 'deleteOrganization'
  >;
  sso: Pick<WorkOS['sso'], 'listConnections'>;
};

const CandidateRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  plan: z.string(),
  is_paid: z.boolean(),
  free_trial_end_at: z.string().nullable(),
  claim_domains: z.string(),
  verified_claims: z.number(),
  auto_join_events: z.number(),
  workos_org_ids: z.string().nullable(),
  parent_organization_id: z.uuid().nullable(),
});

const SsoOrganizationWithClaimsRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sso_domain: z.string(),
  claim_domains: z.string(),
});

export type CleanupCandidate = z.infer<typeof CandidateRowSchema>;
export type SsoOrganizationWithClaims = z.infer<typeof SsoOrganizationWithClaimsRowSchema>;

export type WorkOsSnapshot = {
  id: string;
  name: string;
  externalId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
  domains: { id: string; domain: string; state: string }[];
  connectionCount: number;
};

export type WorkOsCleanupAction =
  | 'delete_workos_organization'
  | 'skip_workos_not_found'
  | 'retain_workos_has_connections'
  | 'retain_workos_has_metadata'
  | 'retain_workos_id_mismatch';

export type OrganizationCleanupStatus = 'planned' | 'completed' | 'failed' | 'aborted';

export type OrganizationCleanupResult = {
  organizationId: string;
  name: string;
  status: OrganizationCleanupStatus;
  workosAction: WorkOsCleanupAction | null;
  claimsDeleted: number;
  workosOrganizationDeleted: boolean;
  reason: string | null;
  candidate: CleanupCandidate;
  claims: OrganizationDomainClaim[];
  workos: WorkOsSnapshot | null;
};

export type VerifiedDomainCleanupReport = {
  runId: string;
  mode: 'dry_run' | 'execute';
  totalCandidates: number;
  results: OrganizationCleanupResult[];
  ssoOrganizationsWithClaims: SsoOrganizationWithClaims[];
  summary: Record<OrganizationCleanupStatus, number>;
};

export type VerifiedDomainCleanupOptions = {
  execute: boolean;
  limit: number;
  organizationIds?: readonly string[];
  provider?: CleanupProvider;
  runId?: string;
};

class CleanupAborted extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const logInfo = sentryLogger(LOG_SOURCE, 'info');
const logError = sentryLogger(LOG_SOURCE, 'error');

function errorDetails(error: unknown): { message: string; status: number | null } {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
  return { message, status };
}

function logEvent(runId: string, event: string, fields: Record<string, unknown> = {}): void {
  logInfo(JSON.stringify({ source: LOG_SOURCE, runId, event, ...fields }));
}

function logFailure(
  runId: string,
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  logError(JSON.stringify({ source: LOG_SOURCE, runId, event, ...errorDetails(error), ...fields }));
  captureException(error, { tags: { source: LOG_SOURCE }, extra: { runId, event, ...fields } });
}

function auditMessage(summary: string, details: Record<string, unknown>): string {
  return `${summary}: ${JSON.stringify(details)}`;
}

async function writeAudit(
  action:
    | 'organization.domain_claim.cleanup_started'
    | 'organization.domain_claim.cleanup_completed'
    | 'organization.domain_claim.cleanup_failed',
  organizationId: string,
  message: string,
  tx?: DrizzleTransaction
): Promise<void> {
  await createAuditLog({
    action,
    actor_id: null,
    actor_email: null,
    actor_name: AUDIT_ACTOR_NAME,
    message,
    organization_id: organizationId,
    tx,
  });
}

export async function findCleanupCandidates(
  organizationIds?: readonly string[]
): Promise<CleanupCandidate[]> {
  const idFilter =
    organizationIds && organizationIds.length > 0
      ? sql`AND o.id IN (${sql.join(
          organizationIds.map(id => sql`${id}::uuid`),
          sql`, `
        )})`
      : sql``;

  const { rows } = await db.execute(sql`
    WITH on_sso AS (
      SELECT o.id
      FROM organizations o
      LEFT JOIN organizations p ON p.id = o.parent_organization_id AND p.deleted_at IS NULL
      WHERE o.deleted_at IS NULL
        AND (o.sso_domain IS NOT NULL OR p.sso_domain IS NOT NULL)
    ),
    claims AS (
      SELECT
        c.organization_id,
        count(*) FILTER (WHERE c.status = 'verified')::int AS verified_claims,
        string_agg(c.domain || ':' || c.status, ', ' ORDER BY c.domain) AS claim_domains,
        string_agg(DISTINCT c.workos_organization_id, ', ') AS workos_org_ids
      FROM organization_domain_claims c
      GROUP BY c.organization_id
    ),
    auto_joins AS (
      SELECT organization_id, count(*)::int AS auto_join_events
      FROM organization_audit_logs
      WHERE action = 'organization.member.auto_join'
      GROUP BY organization_id
    ),
    paid AS (
      SELECT o.id,
        (COALESCE(bool_or(sp.subscription_status IN ('active','trialing') AND sp.expires_at > now()), false)
          OR EXISTS (SELECT 1 FROM credit_transactions ct
                     WHERE ct.organization_id = o.id AND ct.is_free = false AND ct.stripe_payment_id IS NOT NULL)
          OR o.require_seats = false) AS is_paid
      FROM organizations o
      LEFT JOIN organization_seats_purchases sp ON sp.organization_id = o.id
      GROUP BY o.id, o.require_seats
    )
    SELECT
      o.id,
      o.name,
      o.plan,
      pd.is_paid,
      o.free_trial_end_at::text AS free_trial_end_at,
      c.claim_domains,
      c.verified_claims,
      COALESCE(a.auto_join_events, 0)::int AS auto_join_events,
      c.workos_org_ids,
      o.parent_organization_id
    FROM claims c
    JOIN organizations o ON o.id = c.organization_id
    JOIN paid pd ON pd.id = o.id
    LEFT JOIN auto_joins a ON a.organization_id = o.id
    WHERE o.deleted_at IS NULL
      AND o.id NOT IN (SELECT id FROM on_sso)
      ${idFilter}
    ORDER BY (c.verified_claims > 0) DESC, pd.is_paid DESC, o.created_at DESC
  `);
  return z.array(CandidateRowSchema).parse(rows);
}

export async function findSsoOrganizationsWithClaims(): Promise<SsoOrganizationWithClaims[]> {
  const { rows } = await db.execute(sql`
    SELECT
      o.id,
      o.name,
      COALESCE(o.sso_domain, p.sso_domain) AS sso_domain,
      string_agg(c.domain || ':' || c.status, ', ' ORDER BY c.domain) AS claim_domains
    FROM organizations o
    LEFT JOIN organizations p ON p.id = o.parent_organization_id AND p.deleted_at IS NULL
    JOIN organization_domain_claims c ON c.organization_id = o.id
    WHERE o.deleted_at IS NULL
      AND (o.sso_domain IS NOT NULL OR p.sso_domain IS NOT NULL)
    GROUP BY o.id, o.name, o.sso_domain, p.sso_domain
    ORDER BY o.name
  `);
  return z.array(SsoOrganizationWithClaimsRowSchema).parse(rows);
}

async function inspectWorkOsOrganization(
  provider: CleanupProvider,
  organizationId: string
): Promise<WorkOsSnapshot | null> {
  let workosOrganization;
  try {
    workosOrganization = await provider.organizations.getOrganizationByExternalId(organizationId);
  } catch (error) {
    if (errorDetails(error).status === 404) return null;
    throw error;
  }
  const connections = await provider.sso.listConnections({
    organizationId: workosOrganization.id,
  });
  return {
    id: workosOrganization.id,
    name: workosOrganization.name,
    externalId: workosOrganization.externalId,
    metadata: workosOrganization.metadata,
    createdAt: workosOrganization.createdAt,
    domains: workosOrganization.domains.map(({ id, domain, state }) => ({ id, domain, state })),
    connectionCount: connections.data.length,
  };
}

export function planWorkOsAction(
  claims: readonly Pick<OrganizationDomainClaim, 'workos_organization_id'>[],
  workos: WorkOsSnapshot | null
): WorkOsCleanupAction {
  if (!workos) return 'skip_workos_not_found';
  if (workos.connectionCount > 0) return 'retain_workos_has_connections';
  if (Object.keys(workos.metadata).length > 0) return 'retain_workos_has_metadata';
  if (claims.some(c => c.workos_organization_id && c.workos_organization_id !== workos.id)) {
    return 'retain_workos_id_mismatch';
  }
  return 'delete_workos_organization';
}

async function deleteWorkOsOrganization(
  provider: CleanupProvider,
  workosOrganizationId: string
): Promise<void> {
  try {
    await provider.organizations.deleteOrganization(workosOrganizationId);
  } catch (error) {
    if (errorDetails(error).status !== 404) throw error;
  }
}

async function loadClaims(organizationId: string): Promise<OrganizationDomainClaim[]> {
  return db
    .select()
    .from(organization_domain_claims)
    .where(eq(organization_domain_claims.organization_id, organizationId))
    .orderBy(asc(organization_domain_claims.domain));
}

async function cleanupOrganization(
  candidate: CleanupCandidate,
  options: { execute: boolean; provider: CleanupProvider; runId: string }
): Promise<OrganizationCleanupResult> {
  const { execute, provider, runId } = options;
  const organizationId = candidate.id;
  const base = { organizationId, name: candidate.name, candidate };
  logEvent(runId, 'candidate', { organizationId, candidate });

  let claims: OrganizationDomainClaim[] = [];
  let workos: WorkOsSnapshot | null = null;
  let workosAction: WorkOsCleanupAction;
  try {
    claims = await loadClaims(organizationId);
    workos = await inspectWorkOsOrganization(provider, organizationId);
    workosAction = planWorkOsAction(claims, workos);
  } catch (error) {
    logFailure(runId, 'inspection_failed', error, { organizationId });
    return {
      ...base,
      status: 'failed',
      workosAction: null,
      claimsDeleted: 0,
      workosOrganizationDeleted: false,
      reason: `inspection_failed: ${errorDetails(error).message}`,
      claims,
      workos,
    };
  }

  const snapshot = { organization: candidate, claims, workos, workosAction };
  logEvent(runId, 'snapshot', { organizationId, ...snapshot });
  const outcome = { ...base, claims, workos, workosAction };

  if (!execute) {
    return {
      ...outcome,
      status: 'planned',
      claimsDeleted: 0,
      workosOrganizationDeleted: false,
      reason: null,
    };
  }

  try {
    await writeAudit(
      'organization.domain_claim.cleanup_started',
      organizationId,
      auditMessage('Started cleanup of unsupported verified domain claims', { runId, ...snapshot })
    );
  } catch (error) {
    logFailure(runId, 'start_audit_write_failed', error, { organizationId });
    return {
      ...outcome,
      status: 'failed',
      claimsDeleted: 0,
      workosOrganizationDeleted: false,
      reason: `start_audit_write_failed: ${errorDetails(error).message}`,
    };
  }

  let workosOrganizationDeleted = false;
  try {
    const deletedClaimIds = await db.transaction(async tx => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('workos-organization:' || ${organizationId}, 0))`
      );
      const [organization] = await tx
        .select({
          deleted_at: organizations.deleted_at,
          sso_domain: organizations.sso_domain,
          parent_organization_id: organizations.parent_organization_id,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update');
      if (!organization || organization.deleted_at) {
        throw new CleanupAborted('organization_missing_or_deleted');
      }
      if (organization.sso_domain) throw new CleanupAborted('organization_has_sso_domain');
      if (organization.parent_organization_id) {
        const [parent] = await tx
          .select({ sso_domain: organizations.sso_domain })
          .from(organizations)
          .where(
            and(
              eq(organizations.id, organization.parent_organization_id),
              isNull(organizations.deleted_at)
            )
          );
        if (parent?.sso_domain) throw new CleanupAborted('parent_has_sso_domain');
      }

      const currentClaims = await tx
        .select()
        .from(organization_domain_claims)
        .where(eq(organization_domain_claims.organization_id, organizationId))
        .for('update');
      const expectedIds = new Set(claims.map(claim => claim.id));
      if (
        currentClaims.length !== expectedIds.size ||
        currentClaims.some(claim => !expectedIds.has(claim.id))
      ) {
        throw new CleanupAborted('claims_changed');
      }

      if (workosAction === 'delete_workos_organization' && workos) {
        const fresh = await inspectWorkOsOrganization(provider, organizationId);
        if (
          !fresh ||
          fresh.id !== workos.id ||
          planWorkOsAction(currentClaims, fresh) !== workosAction
        ) {
          throw new CleanupAborted('workos_changed');
        }
        await deleteWorkOsOrganization(provider, workos.id);
        workosOrganizationDeleted = true;
        logEvent(runId, 'workos_organization_deleted', {
          organizationId,
          workosOrganizationId: workos.id,
        });
      }

      const deleted = await tx
        .delete(organization_domain_claims)
        .where(
          and(
            eq(organization_domain_claims.organization_id, organizationId),
            inArray(
              organization_domain_claims.id,
              currentClaims.map(claim => claim.id)
            )
          )
        )
        .returning({ id: organization_domain_claims.id });
      await writeAudit(
        'organization.domain_claim.cleanup_completed',
        organizationId,
        auditMessage('Completed cleanup of unsupported verified domain claims', {
          runId,
          workosAction,
          workosOrganizationDeleted,
          claimsDeleted: deleted.length,
          claimIds: deleted.map(claim => claim.id),
        }),
        tx
      );
      return deleted.map(claim => claim.id);
    });

    logEvent(runId, 'organization_completed', {
      organizationId,
      workosAction,
      workosOrganizationDeleted,
      claimIds: deletedClaimIds,
    });
    return {
      ...outcome,
      status: 'completed',
      claimsDeleted: deletedClaimIds.length,
      workosOrganizationDeleted,
      reason: null,
    };
  } catch (error) {
    const aborted = error instanceof CleanupAborted;
    const reason = aborted ? error.reason : errorDetails(error).message;
    if (aborted) {
      logEvent(runId, 'organization_aborted', { organizationId, reason });
    } else {
      logFailure(runId, 'organization_failed', error, {
        organizationId,
        workosOrganizationDeleted,
      });
    }
    try {
      await writeAudit(
        'organization.domain_claim.cleanup_failed',
        organizationId,
        auditMessage('Cleanup of unsupported verified domain claims did not complete', {
          runId,
          outcome: aborted ? 'aborted' : 'failed',
          reason,
          workosAction,
          workosOrganizationDeleted,
        })
      );
    } catch (auditError) {
      logFailure(runId, 'failure_audit_write_failed', auditError, { organizationId });
    }
    return {
      ...outcome,
      status: aborted ? 'aborted' : 'failed',
      claimsDeleted: 0,
      workosOrganizationDeleted,
      reason,
    };
  }
}

function summarize(results: readonly OrganizationCleanupResult[]) {
  const summary: Record<OrganizationCleanupStatus, number> = {
    planned: 0,
    completed: 0,
    failed: 0,
    aborted: 0,
  };
  for (const result of results) summary[result.status] += 1;
  return summary;
}

export async function runVerifiedDomainClaimCleanup(
  options: VerifiedDomainCleanupOptions
): Promise<VerifiedDomainCleanupReport> {
  const runId = options.runId ?? randomUUID();
  const provider = options.provider ?? new WorkOS(WORKOS_API_KEY);
  const mode = options.execute ? 'execute' : 'dry_run';

  const [candidates, ssoOrganizationsWithClaims] = await Promise.all([
    findCleanupCandidates(options.organizationIds),
    findSsoOrganizationsWithClaims(),
  ]);
  const selected = candidates.slice(0, options.limit);
  logEvent(runId, 'run_started', {
    mode,
    totalCandidates: candidates.length,
    selectedOrganizationIds: selected.map(candidate => candidate.id),
    scopedOrganizationIds: options.organizationIds ?? null,
    ssoOrganizationsWithClaims,
  });

  const results: OrganizationCleanupResult[] = [];
  for (const candidate of selected) {
    results.push(
      await cleanupOrganization(candidate, { execute: options.execute, provider, runId })
    );
  }

  const summary = summarize(results);
  logEvent(runId, 'run_finished', { mode, totalCandidates: candidates.length, summary });
  return {
    runId,
    mode,
    totalCandidates: candidates.length,
    results,
    ssoOrganizationsWithClaims,
    summary,
  };
}
