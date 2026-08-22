import type { TRPCContext } from '@/lib/trpc/init';
import {
  organizationTarget,
  recordKiloAdminElevation,
  userTarget,
} from '@/lib/admin/admin-access-log';
import { TRPCError } from '@trpc/server';
import {
  type getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { fetchGitHubRepositories } from '@/lib/integrations/platforms/github/adapter';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';
import {
  getSecurityAgentConfigWithStatus,
  upsertSecurityAgentConfig,
  saveSecurityAgentConfigWithRevision,
  setSecurityAgentEnabled,
} from '@/lib/security-agent/db/security-config';
import {
  listSecurityFindings,
  getSecurityFindingById,
  getSecurityFindingsSummary,
  getLastSyncTime as getLastSyncTimeDb,
  getOrphanedRepositoriesWithFindingCounts,
  deleteFindingsByRepository as deleteFindingsByRepositoryDb,
} from '@/lib/security-agent/db/security-findings';
import { getDashboardStats } from '@/lib/security-agent/db/dashboard-stats';
import {
  getSecurityAgentCommandStatus,
  getSecurityAgentCommandStatuses,
  listActiveSecurityAgentCommands,
  markApplyAutoRemediationCommandAdmissionFailed,
  type SecurityAgentCommandStatusResponse,
} from '@/lib/security-agent/db/security-commands';
import { canStartAnalysis } from '@/lib/security-agent/db/security-analysis';
import {
  decorateFindingWithRemediation,
  decorateFindingsWithRemediation,
  getRemediationAttemptHistory,
  type SecurityFindingWithRemediation,
} from '@/lib/security-agent/db/security-remediation';
import {
  SecurityAgentAuditReportInputSchema,
  SecurityAgentAuditReportQueryError,
  getSecurityAgentAuditReport,
  type SecurityAgentAuditReportInput,
  type SecurityAgentAuditReportOwner,
} from '@/lib/security-agent/db/security-audit-report';
import {
  hasSecurityReviewPermissions,
  getReauthorizeUrl,
} from '@/lib/security-agent/github/permissions';
import { checkDependabotAlertsAvailability } from '@/lib/security-agent/github/dependabot-api';
import { submitManualSecuritySync } from '@/lib/security-agent/services/manual-sync-client';
import { submitManualFindingDismissal } from '@/lib/security-agent/services/manual-dismiss-client';
import { submitManualAnalysisStart } from '@/lib/security-agent/services/manual-analysis-client';
import {
  submitApplyAutoRemediation,
  submitManualRemediationStart,
  submitRemediationCancellation,
} from '@/lib/security-agent/services/manual-remediation-client';
import {
  autoDismissEligibleFindings,
  countEligibleForAutoDismiss,
} from '@/lib/security-agent/services/auto-dismiss-service';
import type { SecurityReviewOwner } from '@/lib/security-agent/core/types';
import {
  operation_ledgers,
  organizations,
  security_audit_log,
  type OperationLedgerRow,
  type SecurityFinding,
} from '@kilocode/db/schema';
import {
  buildSecurityFindingAuditHumanActor,
  REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS,
} from '@kilocode/worker-utils/security-finding-audit';
import { db } from '@/lib/drizzle';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  SaveSecurityConfigInputSchema,
  ListFindingsInputSchema,
  TriggerSyncInputSchema,
  DismissFindingInputSchema,
  GetFindingInputSchema,
  SetEnabledInputSchema,
  StartAnalysisInputSchema,
  StartRemediationInputSchema,
  RetryRemediationInputSchema,
  CancelRemediationInputSchema,
  GetAnalysisInputSchema,
  GetCommandStatusInputSchema,
  GetCommandStatusesInputSchema,
  DeleteFindingsByRepoInputSchema,
  GetDashboardStatsInputSchema,
  TrackSecurityAgentUiInteractionInputSchema,
  type SaveSecurityConfigInput,
  type ListFindingsInput,
  type TriggerSyncInput,
  type DismissFindingInput,
  type GetFindingInput,
  type SetEnabledInput,
  type StartAnalysisInput,
  type StartRemediationInput,
  type RetryRemediationInput,
  type CancelRemediationInput,
  type GetAnalysisInput,
  type GetCommandStatusInput,
  type GetCommandStatusesInput,
  type DeleteFindingsByRepoInput,
  type GetDashboardStatsInput,
  type TrackSecurityAgentUiInteractionInput,
} from '@/lib/security-agent/core/schemas';
import {
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  DEFAULT_SECURITY_AGENT_CONFIG,
} from '@/lib/security-agent/core/constants';
import {
  trackSecurityAgentEnabled,
  trackSecurityAgentConfigSaved,
  trackSecurityAgentSync,
  trackSecurityAgentFindingDismissed,
  trackSecurityAgentUiInteraction,
  trackSecurityAgentRemediationAction,
} from '@/lib/security-agent/posthog-tracking';
import {
  createSecurityAuditLog,
  logSecurityAudit,
  SecurityAuditLogAction,
} from '@/lib/security-agent/services/audit-log-service';
import {
  admitOperation,
  isTerminalOperationStatus,
  markReconcilePending,
  recordOperationAcceptance,
  settleOperation,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';

// ---------------------------------------------------------------------------
// Strategy types
// ---------------------------------------------------------------------------

type Owner = { type: 'user' | 'org'; id: string; userId: string };

type Integration = Awaited<ReturnType<typeof getIntegrationForOwner>>;

/**
 * TExtra represents additional input fields injected by the tRPC procedure middleware.
 * For personal routers this is `{}`, for org routers it is `{ organizationId: string }`.
 * This avoids `as` casts throughout the handlers and org router callbacks.
 */
type SecurityAgentDeps<TExtra = {}> = {
  resolveOwner: (ctx: TRPCContext, input: TExtra) => Owner;
  resolveSecurityOwner: (ctx: TRPCContext, input: TExtra) => SecurityReviewOwner;
  resolveResourceId: (ctx: TRPCContext, input: TExtra) => string;
  verifyFindingOwnership: (finding: SecurityFinding, ctx: TRPCContext, input: TExtra) => boolean;
  getIntegration: (ctx: TRPCContext, input: TExtra) => Promise<Integration>;
  trackingExtras: (ctx: TRPCContext, input: TExtra) => { organizationId?: string };
};

function getRepoFullNamesInScope(
  integration: Integration,
  config: { repository_selection_mode?: 'all' | 'selected'; selected_repository_ids?: number[] }
): string[] {
  const repositories = requireNumericPlatformRepositories(integration?.repositories ?? null) ?? [];
  if (config.repository_selection_mode === 'all') {
    return repositories.map(repo => repo.full_name).filter((name): name is string => !!name);
  }
  const selectedIds = new Set(config.selected_repository_ids ?? []);
  return repositories
    .filter(repo => selectedIds.has(repo.id))
    .map(repo => repo.full_name)
    .filter((name): name is string => !!name);
}

async function resolveAuditReportOwner(
  ctx: TRPCContext,
  owner: Owner
): Promise<SecurityAgentAuditReportOwner> {
  if (owner.type === 'user') {
    return {
      type: 'user',
      id: ctx.user.id,
      displayName: ctx.user.google_user_name || ctx.user.google_user_email || 'Personal owner',
    };
  }

  const [organization] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, owner.id))
    .limit(1);

  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }

  return {
    type: 'organization',
    id: owner.id,
    displayName: organization.name,
  };
}

async function logPlatformAdminAuditReportAccess(params: {
  ctx: TRPCContext;
  owner: SecurityAgentAuditReportOwner;
  periodStart: string;
  periodEndExclusive: string;
}): Promise<void> {
  if (!params.ctx.user.is_admin) return;

  const securityOwner =
    params.owner.type === 'organization'
      ? { organizationId: params.owner.id }
      : { userId: params.owner.id };

  await createSecurityAuditLog({
    owner: securityOwner,
    actor_id: params.ctx.user.id,
    actor_email: params.ctx.user.google_user_email,
    actor_name: params.ctx.user.google_user_name,
    action: SecurityAuditLogAction.AuditReportGenerated,
    resource_type: 'security_agent_audit_report',
    resource_id: `${params.owner.type}:${params.owner.id}`,
    metadata: {
      owner_type: params.owner.type,
      period_start: params.periodStart,
      period_end_exclusive: params.periodEndExclusive,
      report_version: 1,
    },
  });
}

async function assembleAuditReportResponse<TExtra>(params: {
  ctx: TRPCContext;
  input: SecurityAgentAuditReportInput & TExtra;
  deps: SecurityAgentDeps<TExtra>;
}): Promise<
  | { status: 'ok'; report: Awaited<ReturnType<typeof getSecurityAgentAuditReport>> }
  | { status: 'query_failed'; message: 'Report query did not finish' }
> {
  const owner = await resolveAuditReportOwner(
    params.ctx,
    params.deps.resolveOwner(params.ctx, params.input)
  );

  if (params.ctx.user.is_admin) {
    // `isRequestingUserKiloAdmin` below unmasks Kilo-admin and unattributed
    // actors that a customer would see as "Kilo Admin"/"Masked user". Recorded
    // before the query so an over-budget or failed report still attributes the
    // attempt; the DB-backed security audit log is written on success only.
    await recordKiloAdminElevation(params.ctx, {
      reason: 'security_agent_audit_report',
      target: owner.type === 'organization' ? organizationTarget(owner.id) : userTarget(owner.id),
    });
  }

  try {
    const report = await getSecurityAgentAuditReport({
      owner,
      input: params.input,
      isRequestingUserKiloAdmin: params.ctx.user.is_admin,
    });
    await logPlatformAdminAuditReportAccess({
      ctx: params.ctx,
      owner,
      periodStart: report.period.start,
      periodEndExclusive: report.period.endExclusive,
    });
    return { status: 'ok', report };
  } catch (error) {
    if (error instanceof SecurityAgentAuditReportQueryError) {
      return { status: 'query_failed', message: 'Report query did not finish' };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Security operation ledger (P1-A-08e)
// ---------------------------------------------------------------------------
//
// The manual sync and finding dismissal procedures accept an optional
// `operationKey`. When present, the handler admits a `security`-domain ledger
// row BEFORE submitting to the security-sync Worker, and only then runs the
// submission. Later same-key calls dedupe, replay the canonical result, or
// conflict. The Worker dedupes the command itself by `operation_key`, so the
// Worker settles the ledger row from the terminal command state. The
// `getCommandStatus` handler retries that settle as a fallback, joined by the
// stored `provider_ref` (the Worker's `commandId`). A
// definitive pre-acceptance rejection (4xx, disabled routing, unconfigured
// service) settles the row `failed`; an ambiguous transport outcome
// (network/5xx/lost correlation ids) marks the row `reconcile_pending` so a
// same-key retry re-submits instead of re-executing blind.

type SecurityLedgerIntent =
  | 'manual_sync'
  | 'dismiss_finding'
  | 'start_analysis'
  | 'apply_auto_remediation';

const SECURITY_LEDGER_INTENTS: readonly SecurityLedgerIntent[] = [
  'manual_sync',
  'dismiss_finding',
  'start_analysis',
  'apply_auto_remediation',
];

function isSecurityLedgerIntent(value: string): value is SecurityLedgerIntent {
  return (SECURITY_LEDGER_INTENTS as readonly string[]).includes(value);
}

/** The Worker's acceptance receipt and correlation ids. */
type AcceptedCommandIds = {
  accepted: true;
  commandId: string;
  /** Correlation ids are absent for intents without a queue run (analysis). */
  runId?: string;
  messageId?: string;
};

type SecurityCommandResult =
  | { kind: 'accepted'; accepted: AcceptedCommandIds }
  | { kind: 'replayed'; canonical: Record<string, unknown> };

/** `security_command_settled` outbox payload (DEC-05): no free text, no resource keys. */
function securitySettledOutboxEvent(params: {
  distinctId: string;
  intent: SecurityLedgerIntent;
  outcome: 'completed' | 'failed' | 'no_op' | 'ambiguous';
  startedAt: number;
}): OutboxEventInput {
  return {
    eventName: 'security_command_settled',
    distinctId: params.distinctId,
    properties: {
      source: 'web',
      surface: 'security',
      phase: 'terminal',
      intent: params.intent,
      outcome: params.outcome,
      duration_ms: Math.max(0, Date.now() - params.startedAt),
    },
  };
}

function securityOwnerScopeKey(owner: SecurityReviewOwner): string {
  return 'organizationId' in owner && owner.organizationId
    ? `org:${owner.organizationId}`
    : `user:${owner.userId}`;
}

/** Security ledger resource identity for a manual sync (owner scope + repo). */
function securitySyncLedgerResourceKey(owner: SecurityReviewOwner, repoFullName?: string): string {
  return `security:manual_sync:${securityOwnerScopeKey(owner)}:${repoFullName ?? '*'}`;
}

/** Trimmed, whitespace-collapsed comment, so cosmetic spacing is not a key-reuse mismatch. */
function normalizeDismissComment(comment?: string): string {
  return (comment ?? '').trim().replace(/\s+/g, ' ');
}

/** Security ledger resource identity for a finding dismissal. */
function securityDismissLedgerResourceKey(
  owner: SecurityReviewOwner,
  findingId: string,
  reason: string,
  comment?: string
): string {
  return `security:dismiss_finding:${securityOwnerScopeKey(owner)}:${findingId}:${reason}:${normalizeDismissComment(comment)}`;
}

/** Security ledger resource identity for a manual analysis start. */
function securityAnalysisLedgerResourceKey(owner: SecurityReviewOwner, findingId: string): string {
  return `security:start_analysis:${securityOwnerScopeKey(owner)}:${findingId}`;
}

/** Security ledger resource identity for a remediation attempt. */
function securityRemediationLedgerResourceKey(
  owner: SecurityReviewOwner,
  findingId: string
): string {
  return `security:apply_auto_remediation:${securityOwnerScopeKey(owner)}:${findingId}`;
}

/**
 * The ledger user id for a security owner. Personal scope uses the owner user.
 * Org scope has no single acting user, so it approximates with the
 * organization's `created_by_kilo_user_id` (the `kilo_user_id` column is NOT
 * NULL). Returns null when the org has no creator, in which case the admit is
 * skipped and the terminal settle later skips on the missing row.
 */
async function resolveSecurityLedgerUserId(owner: SecurityReviewOwner): Promise<string | null> {
  if (!('organizationId' in owner) || !owner.organizationId) {
    return owner.userId ?? null;
  }
  const [org] = await db
    .select({ createdBy: organizations.created_by_kilo_user_id })
    .from(organizations)
    .where(eq(organizations.id, owner.organizationId))
    .limit(1);
  return org?.createdBy ?? null;
}

/**
 * Admits a `security`-domain ledger row for an already-created remediation
 * attempt and records the attempt id as the provider reference. The Worker
 * settles the row from the terminal callback. Best-effort: the remediation
 * effect already committed, so a ledger write failure must not fail the
 * request; the terminal settle then skips on the missing row.
 */
async function admitSecurityRemediationLedgerRow(params: {
  owner: SecurityReviewOwner;
  findingId: string;
  attemptId: string;
  remediationId: string;
  attemptNumber: number;
}): Promise<void> {
  try {
    const userId = await resolveSecurityLedgerUserId(params.owner);
    if (!userId) {
      console.error('Skipping security remediation ledger admission: no ledger user id', {
        attemptId: params.attemptId,
      });
      return;
    }
    const admission = await admitOperation(db, {
      userId,
      orgId:
        'organizationId' in params.owner && params.owner.organizationId
          ? params.owner.organizationId
          : null,
      domain: 'security',
      intent: 'apply_auto_remediation',
      operationKey: `remediation:${params.attemptId}`,
      resourceKey: securityRemediationLedgerResourceKey(params.owner, params.findingId),
      taxonomy: 'reconcile-first',
      leaseSeconds: 120,
    });
    if (admission.admission !== 'admitted') return;
    await recordOperationAcceptance(db, {
      rowId: admission.row.id,
      providerRef: params.attemptId,
      canonicalResult: {
        attemptId: params.attemptId,
        remediationId: params.remediationId,
        attemptNumber: params.attemptNumber,
      },
    });
  } catch (error) {
    console.error('Failed to admit the security remediation ledger row', {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runs a ledger write whose failure must never produce a success receipt:
 * `work` resolves false when nothing durable was written. Both cases surface
 * `message` as a typed server error, and a same-key retry re-records.
 */
async function requireLedgerWrite(message: string, work: () => Promise<boolean>): Promise<void> {
  try {
    if (!(await work())) {
      throw new Error('the ledger row was missing or in an unexpected state');
    }
  } catch (error) {
    console.error(
      `Security operation ledger write failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: error });
  }
}

/** The replay receipt for a settled row; only `completed`/`no_op` may replay. */
function replaySettledSecurityRow(row: OperationLedgerRow): Record<string, unknown> {
  if (row.status === 'completed' || row.status === 'no_op') {
    return row.canonical_result ?? {};
  }
  // A settled `failed` row cannot be recovered under the same key: surface a
  // non-retryable typed rejection so the client starts a fresh intent.
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'This action did not complete. Please try again.',
  });
}

/** The handler response for a replayed duplicate, built from the stored result. */
function replayedSecurityResponse(canonical: Record<string, unknown>) {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    success: true as const,
    accepted: true as const,
    commandId: text(canonical.commandId),
    runId: text(canonical.runId),
    messageId: text(canonical.messageId),
    replayed: true as const,
  };
}

/**
 * Runs the Worker submission under an already-admitted row:
 * - acceptance records the provider reference durably, then returns accepted;
 * - a definitive pre-acceptance rejection settles the row `failed`;
 * - an ambiguous transport outcome (BAD_GATEWAY) marks the row
 *   `reconcile_pending` and surfaces a retryable CONFLICT.
 */
async function executeSecurityCommandSubmit(args: {
  row: OperationLedgerRow;
  intent: SecurityLedgerIntent;
  distinctId: string;
  startedAt: number;
  submit: () => Promise<AcceptedCommandIds>;
}): Promise<AcceptedCommandIds> {
  const outboxEvent = (outcome: 'failed' | 'ambiguous') =>
    securitySettledOutboxEvent({
      distinctId: args.distinctId,
      intent: args.intent,
      outcome,
      startedAt: args.startedAt,
    });

  let accepted: AcceptedCommandIds;
  try {
    accepted = await args.submit();
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_GATEWAY') {
      // The ambiguous CONFLICT promises same-key reconciliation, so it is
      // surfaced only once `reconcile_pending` is durable.
      await requireLedgerWrite(
        'We could not record this action. Please try again later.',
        async () =>
          (
            await markReconcilePending(db, {
              rowId: args.row.id,
              outboxEvent: outboxEvent('ambiguous'),
            })
          )?.status === 'reconcile_pending'
      );
      throw new TRPCError({
        code: 'CONFLICT',
        message: "Couldn't confirm — check the security review before retrying.",
      });
    }
    // Best effort: the caller already receives the typed rejection, so a
    // failed settle must not mask it. A later same-key retry re-records.
    try {
      await settleOperation(db, {
        rowId: args.row.id,
        status: 'failed',
        outcomeCode: 'pre_acceptance_rejected',
        outboxEvent: outboxEvent('failed'),
      });
    } catch (settleError) {
      console.error('Failed to settle the security operation ledger row', settleError);
    }
    throw error;
  }
  // The Worker accepted, so an unrecorded provider reference must never yield a
  // success receipt: surface a retryable error and let a same-key retry
  // re-submit. `provider_ref` holds the `commandId`, which is what the terminal
  // command state is later joined back to this row by.
  await requireLedgerWrite(
    'The action completed, but we could not record the result. Please try again.',
    async () =>
      (await recordOperationAcceptance(db, {
        rowId: args.row.id,
        providerRef: accepted.commandId,
        canonicalResult: {
          commandId: accepted.commandId,
          ...(accepted.runId !== undefined ? { runId: accepted.runId } : {}),
          ...(accepted.messageId !== undefined ? { messageId: accepted.messageId } : {}),
        },
      })) !== null
  );
  return accepted;
}

/**
 * Admits a `security`-domain ledger row and routes the admission:
 * `admitted` runs the Worker submission; `takeover`/`duplicate_reconcile_pending`
 * re-submit (the Worker owns the sync state, so reconciliation is a re-enqueue
 * under the same key); `duplicate_settled` replays the canonical result;
 * in-flight admissions conflict. Cross-intent key reuse is rejected before any
 * outcome is honored.
 */
async function runSecurityLedgerSubmit(args: {
  ctx: TRPCContext;
  owner: SecurityReviewOwner;
  intent: SecurityLedgerIntent;
  operationKey: string;
  resourceKey: string;
  submit: () => Promise<AcceptedCommandIds>;
}): Promise<SecurityCommandResult> {
  const distinctId = args.ctx.user.google_user_email || args.ctx.user.id;
  const startedAt = Date.now();
  const admission = await admitOperation(db, {
    userId: args.ctx.user.id,
    orgId:
      'organizationId' in args.owner && args.owner.organizationId
        ? args.owner.organizationId
        : null,
    domain: 'security',
    intent: args.intent,
    operationKey: args.operationKey,
    resourceKey: args.resourceKey,
    taxonomy: 'reconcile-first',
    // While an `admitted` row holds this lease, same-key retries conflict.
    leaseSeconds: 120,
  });

  if (admission.row.intent !== args.intent || admission.row.resource_key !== args.resourceKey) {
    throw new TRPCError({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
  }

  switch (admission.admission) {
    case 'admitted':
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return {
        kind: 'accepted',
        accepted: await executeSecurityCommandSubmit({
          row: admission.row,
          intent: args.intent,
          distinctId,
          startedAt,
          submit: args.submit,
        }),
      };
    case 'duplicate_settled':
      return { kind: 'replayed', canonical: replaySettledSecurityRow(admission.row) };
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      throw new TRPCError({ code: 'CONFLICT', message: 'operation_in_progress' });
  }
}

/** Command status → ledger terminal status; a non-terminal command has none. */
const SECURITY_COMMAND_TERMINAL_STATUS = {
  succeeded: 'completed',
  failed: 'failed',
  no_op: 'no_op',
} as const;

/**
 * Retries settlement for a terminal command when the Worker did not complete
 * it. The row is joined by `provider_ref` (the Worker
 * `commandId`) recorded at acceptance and scoped to the admitting user, so a
 * poll never settles another user's row. The settle is a compare-and-set, so
 * later polls are no-ops and the event is emitted exactly once. A settle
 * failure must not fail the status read: the next poll retries it.
 */
async function settleSecurityLedgerForTerminalCommand(params: {
  ctx: TRPCContext;
  command: SecurityAgentCommandStatusResponse;
}): Promise<void> {
  const status =
    SECURITY_COMMAND_TERMINAL_STATUS[
      params.command.status as keyof typeof SECURITY_COMMAND_TERMINAL_STATUS
    ];
  if (!status) return;

  try {
    const [row] = await db
      .select({
        id: operation_ledgers.id,
        intent: operation_ledgers.intent,
        status: operation_ledgers.status,
        admitted_at: operation_ledgers.admitted_at,
      })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.domain, 'security'),
          eq(operation_ledgers.kilo_user_id, params.ctx.user.id),
          eq(operation_ledgers.provider_ref, params.command.id)
        )
      )
      .limit(1);
    if (!row || isTerminalOperationStatus(row.status)) return;
    if (!isSecurityLedgerIntent(row.intent)) return;

    await settleOperation(db, {
      rowId: row.id,
      status,
      outcomeCode: params.command.resultCode,
      outboxEvent: securitySettledOutboxEvent({
        distinctId: params.ctx.user.google_user_email || params.ctx.user.id,
        intent: row.intent,
        outcome: status,
        startedAt: new Date(row.admitted_at).getTime(),
      }),
    });
  } catch (error) {
    console.error('Failed to settle the security operation ledger row from the command state', {
      command_id: params.command.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Findings list DTO
// ---------------------------------------------------------------------------
//
// The list response nulls `raw_data`, the raw Dependabot alert JSON. It is the
// only heavy field no list UI reads. The detail procedure `getFinding` still
// returns it. The web detail dialog is fed from the list
// and reads `analysis` and `remediationSummary` (including `latestAttempt`),
// so both stay fully intact. The decorator needs the full row, so the SQL
// select stays untouched and the response nulls `raw_data` after decoration.

function toFindingListItem(
  finding: SecurityFindingWithRemediation
): SecurityFindingWithRemediation {
  return { ...finding, raw_data: null };
}

// ---------------------------------------------------------------------------
// Remediation progress timeline (detail-only)
// ---------------------------------------------------------------------------
//
// The remediation panel renders the ordered remediation audit events for one
// finding. The list decorator stays lean (P2-GH-45a); this detail-only query
// reads the audit log directly. Only the remediation members of
// REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS are timeline events — finding
// lifecycle events are not.

// The remediation members of REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS are the
// timeline events. Filtered from the worker-utils constant (not the
// audit-log-service enum, which tests mock with a partial object) so the six
// remediation action strings stay real.
const REMEDIATION_TIMELINE_ACTIONS = REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS.filter(action =>
  action.startsWith('security.remediation.')
);

type RemediationTimelineEvent = {
  action: string;
  occurredAt: string;
};

async function getRemediationTimeline(findingId: string): Promise<RemediationTimelineEvent[]> {
  const effectiveAt = sql<string>`COALESCE(${security_audit_log.occurred_at}, ${security_audit_log.created_at})`;
  const rows = await db
    .select({
      action: security_audit_log.action,
      occurredAt: effectiveAt,
    })
    .from(security_audit_log)
    .where(
      and(
        eq(security_audit_log.finding_id, findingId),
        inArray(security_audit_log.action, [...REMEDIATION_TIMELINE_ACTIONS])
      )
    )
    .orderBy(asc(effectiveAt));

  return rows.map(row => ({
    action: row.action,
    occurredAt: new Date(row.occurredAt).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSecurityAgentHandlers<TExtra = {}>(deps: SecurityAgentDeps<TExtra>) {
  // tRPC passes `undefined` for no-input procedures.  For the personal router
  // TExtra = {}, so the fallback `{}` is structurally correct.  For the org
  // router the middleware always injects `{ organizationId }`.  The cast is
  // the single unavoidable type-unsafe bridge between tRPC's `unknown` input
  // and our generic callbacks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toExtra = (input: unknown): TExtra => (input ?? {}) as any;

  return {
    trackUiInteraction: {
      inputSchema: TrackSecurityAgentUiInteractionInputSchema,
      handler: async ({
        ctx,
        input,
      }: {
        ctx: TRPCContext;
        input: TrackSecurityAgentUiInteractionInput & TExtra;
      }) => {
        trackSecurityAgentUiInteraction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          interaction: input.interaction,
        });

        return { success: true };
      },
    },

    // -----------------------------------------------------------------------
    // 1. getPermissionStatus
    // -----------------------------------------------------------------------
    getPermissionStatus: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const integration = await deps.getIntegration(ctx, extra);

      if (!integration || integration.integration_status !== 'active') {
        return {
          hasIntegration: false,
          hasPermissions: false,
          reauthorizeUrl: null,
          authInvalidAt: integration?.auth_invalid_at ?? null,
          authInvalidReason: integration?.auth_invalid_reason ?? null,
        };
      }

      const hasPermissions = hasSecurityReviewPermissions(integration);
      // UI reauthorization state is intentionally time-invariant: once GitHub returns
      // auth-invalid, keep prompting until a sync or install-refresh path clears the flag.
      const hasEffectivePermissions = hasPermissions && !integration.auth_invalid_at;

      return {
        hasIntegration: true,
        hasPermissions: hasEffectivePermissions,
        reauthorizeUrl: hasEffectivePermissions
          ? null
          : integration.platform_installation_id
            ? getReauthorizeUrl(integration.platform_installation_id)
            : null,
        authInvalidAt: integration.auth_invalid_at,
        authInvalidReason: integration.auth_invalid_reason,
      };
    },

    // -----------------------------------------------------------------------
    // 2. getConfig
    // -----------------------------------------------------------------------
    getConfig: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const owner = deps.resolveOwner(ctx, extra);
      const result = await getSecurityAgentConfigWithStatus(owner);

      if (!result) {
        return {
          hasConfig: false,
          configRevision: null,
          isEnabled: false,
          slaCriticalDays: 15,
          slaHighDays: 30,
          slaMediumDays: 45,
          slaLowDays: 90,
          slaEnabled: DEFAULT_SECURITY_AGENT_CONFIG.sla_enabled,
          autoSyncEnabled: true,
          repositorySelectionMode: 'selected' as const,
          selectedRepositoryIds: [] as number[],
          modelSlug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
          triageModelSlug: DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
          analysisModelSlug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
          analysisMode: 'auto' as const,
          autoDismissEnabled: false,
          autoDismissConfidenceThreshold: 'high' as const,
          autoAnalysisEnabled: false,
          autoAnalysisMinSeverity: 'high' as const,
          autoAnalysisIncludeExisting: false,
          autoRemediationEnabled: false,
          autoRemediationMinSeverity: 'high' as const,
          autoRemediationIncludeExisting: false,
          autoRemediationRequireApproval: true,
          autoRemediationEnabledAt: null,
          remediationModelSlug: DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
          slaNotificationsEnabled: DEFAULT_SECURITY_AGENT_CONFIG.sla_notifications_enabled,
          slaNotificationMinSeverity: DEFAULT_SECURITY_AGENT_CONFIG.sla_notification_min_severity,
          slaNotificationWarningDays: DEFAULT_SECURITY_AGENT_CONFIG.sla_notification_warning_days,
          newFindingNotificationsEnabled:
            DEFAULT_SECURITY_AGENT_CONFIG.new_finding_notifications_enabled,
          newFindingNotificationMinSeverity:
            DEFAULT_SECURITY_AGENT_CONFIG.new_finding_notification_min_severity,
        };
      }

      const triageModelSlug =
        result.storedConfig.triage_model_slug ??
        result.storedConfig.model_slug ??
        result.config.triage_model_slug ??
        DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
      const analysisModelSlug =
        result.storedConfig.analysis_model_slug ??
        result.storedConfig.model_slug ??
        result.config.analysis_model_slug ??
        DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;
      const remediationModelSlug =
        result.storedConfig.remediation_model_slug ??
        result.config.remediation_model_slug ??
        analysisModelSlug ??
        DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL;

      return {
        hasConfig: true,
        configRevision: result.configRevision,
        isEnabled: result.isEnabled,
        slaCriticalDays: result.config.sla_critical_days,
        slaHighDays: result.config.sla_high_days,
        slaMediumDays: result.config.sla_medium_days,
        slaLowDays: result.config.sla_low_days,
        slaEnabled: result.config.sla_enabled,
        autoSyncEnabled: result.config.auto_sync_enabled,
        repositorySelectionMode: result.config.repository_selection_mode || 'selected',
        selectedRepositoryIds: result.config.selected_repository_ids || [],
        modelSlug: result.config.model_slug || analysisModelSlug,
        triageModelSlug,
        analysisModelSlug,
        analysisMode: result.config.analysis_mode ?? 'auto',
        autoDismissEnabled: result.config.auto_dismiss_enabled ?? false,
        autoDismissConfidenceThreshold: result.config.auto_dismiss_confidence_threshold ?? 'high',
        autoAnalysisEnabled: result.config.auto_analysis_enabled ?? false,
        autoAnalysisMinSeverity: result.config.auto_analysis_min_severity ?? 'high',
        autoAnalysisIncludeExisting: result.config.auto_analysis_include_existing ?? false,
        autoRemediationEnabled: result.config.auto_remediation_enabled ?? false,
        autoRemediationMinSeverity: result.config.auto_remediation_min_severity ?? 'high',
        autoRemediationIncludeExisting: result.config.auto_remediation_include_existing ?? false,
        autoRemediationRequireApproval: result.config.auto_remediation_require_approval ?? true,
        autoRemediationEnabledAt: result.config.auto_remediation_enabled_at ?? null,
        remediationModelSlug,
        slaNotificationsEnabled: result.config.sla_notifications_enabled,
        slaNotificationMinSeverity: result.config.sla_notification_min_severity,
        slaNotificationWarningDays: result.config.sla_notification_warning_days,
        newFindingNotificationsEnabled: result.config.new_finding_notifications_enabled,
        newFindingNotificationMinSeverity: result.config.new_finding_notification_min_severity,
      };
    },

    // -----------------------------------------------------------------------
    // 3. saveConfig
    // -----------------------------------------------------------------------
    saveConfig: {
      inputSchema: SaveSecurityConfigInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: SaveSecurityConfigInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const resourceId = deps.resolveResourceId(ctx, input);

        const existingConfig = await getSecurityAgentConfigWithStatus(owner);
        const existingTriageModelSlug =
          existingConfig?.storedConfig.triage_model_slug ??
          existingConfig?.storedConfig.model_slug ??
          existingConfig?.config.triage_model_slug ??
          DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
        const existingAnalysisModelSlug =
          existingConfig?.storedConfig.analysis_model_slug ??
          existingConfig?.storedConfig.model_slug ??
          existingConfig?.config.analysis_model_slug ??
          DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;
        const beforeState = existingConfig
          ? {
              autoSyncEnabled: existingConfig.config.auto_sync_enabled,
              analysisMode: existingConfig.config.analysis_mode,
              autoDismissEnabled: existingConfig.config.auto_dismiss_enabled,
              autoDismissConfidenceThreshold:
                existingConfig.config.auto_dismiss_confidence_threshold,
              autoAnalysisEnabled: existingConfig.config.auto_analysis_enabled,
              autoAnalysisMinSeverity: existingConfig.config.auto_analysis_min_severity,
              autoAnalysisIncludeExisting: existingConfig.config.auto_analysis_include_existing,
              autoRemediationEnabled: existingConfig.config.auto_remediation_enabled,
              autoRemediationMinSeverity: existingConfig.config.auto_remediation_min_severity,
              autoRemediationIncludeExisting:
                existingConfig.config.auto_remediation_include_existing,
              autoRemediationEnabledAt: existingConfig.config.auto_remediation_enabled_at,
              remediationModelSlug:
                existingConfig.config.remediation_model_slug ?? existingAnalysisModelSlug,
              modelSlug: existingConfig.config.model_slug,
              triageModelSlug: existingTriageModelSlug,
              analysisModelSlug: existingAnalysisModelSlug,
              repositorySelectionMode: existingConfig.config.repository_selection_mode,
              selectedRepositoryIds: existingConfig.config.selected_repository_ids,
              slaCriticalDays: existingConfig.config.sla_critical_days,
              slaHighDays: existingConfig.config.sla_high_days,
              slaMediumDays: existingConfig.config.sla_medium_days,
              slaLowDays: existingConfig.config.sla_low_days,
              slaEnabled: existingConfig.config.sla_enabled,
              slaNotificationsEnabled: existingConfig.config.sla_notifications_enabled,
              slaNotificationMinSeverity: existingConfig.config.sla_notification_min_severity,
              slaNotificationWarningDays: existingConfig.config.sla_notification_warning_days,
              newFindingNotificationsEnabled:
                existingConfig.config.new_finding_notifications_enabled,
              newFindingNotificationMinSeverity:
                existingConfig.config.new_finding_notification_min_severity,
            }
          : undefined;

        const triageModelSlug =
          input.triageModelSlug ??
          (input.modelSlug ? input.modelSlug : undefined) ??
          existingTriageModelSlug;
        const analysisModelSlug =
          input.analysisModelSlug ??
          (input.modelSlug ? input.modelSlug : undefined) ??
          existingAnalysisModelSlug;
        const modelSlug =
          input.modelSlug ??
          existingConfig?.storedConfig.model_slug ??
          analysisModelSlug ??
          triageModelSlug;
        const remediationModelSlug =
          input.remediationModelSlug ??
          existingConfig?.storedConfig.remediation_model_slug ??
          existingConfig?.config.remediation_model_slug ??
          analysisModelSlug;

        // Enqueue backlog findings when include_existing becomes active — either
        // because it was just toggled ON, or because auto-analysis was re-enabled
        // while include_existing was already ON.
        const wasAutoAnalysisOn = existingConfig?.config.auto_analysis_enabled ?? false;
        const isAutoAnalysisOn =
          input.autoAnalysisEnabled ?? existingConfig?.config.auto_analysis_enabled ?? false;
        const wasIncludeExisting = existingConfig?.config.auto_analysis_include_existing ?? false;
        const isNowIncludeExisting = input.autoAnalysisIncludeExisting ?? wasIncludeExisting;

        const includeExistingJustTurnedOn = isNowIncludeExisting && !wasIncludeExisting;
        const autoAnalysisReEnabled =
          isAutoAnalysisOn && !wasAutoAnalysisOn && isNowIncludeExisting;

        const shouldEnqueueAnalysis =
          isAutoAnalysisOn && (includeExistingJustTurnedOn || autoAnalysisReEnabled);

        const wasAutoRemediationOn = existingConfig?.config.auto_remediation_enabled ?? false;
        const isAutoRemediationOn =
          input.autoRemediationEnabled ?? existingConfig?.config.auto_remediation_enabled ?? false;
        const wasRemediationIncludeExisting =
          existingConfig?.config.auto_remediation_include_existing ?? false;
        const isNowRemediationIncludeExisting =
          input.autoRemediationIncludeExisting ?? wasRemediationIncludeExisting;
        const remediationIncludeExistingJustTurnedOn =
          isNowRemediationIncludeExisting && !wasRemediationIncludeExisting;
        const autoRemediationReEnabled =
          isAutoRemediationOn && !wasAutoRemediationOn && isNowRemediationIncludeExisting;
        const remediationThresholdChanged =
          isAutoRemediationOn &&
          isNowRemediationIncludeExisting &&
          !!input.autoRemediationMinSeverity &&
          input.autoRemediationMinSeverity !== existingConfig?.config.auto_remediation_min_severity;
        const wasApprovalRequired =
          existingConfig?.config.auto_remediation_require_approval ?? false;
        const isNowApprovalRequired = input.autoRemediationRequireApproval ?? wasApprovalRequired;
        const approvalJustTurnedOff = !isNowApprovalRequired && wasApprovalRequired;

        const shouldEnqueueRemediation =
          isAutoRemediationOn &&
          (remediationIncludeExistingJustTurnedOn ||
            autoRemediationReEnabled ||
            remediationThresholdChanged ||
            approvalJustTurnedOff);

        // Compare-and-set save: the config write, the include-existing analysis
        // enqueue, and the include-existing remediation command all commit in one
        // transaction. A stale revision or an enqueue failure rolls back.
        const saveOutcome = await saveSecurityAgentConfigWithRevision({
          owner,
          config: {
            sla_critical_days: input.slaCriticalDays,
            sla_high_days: input.slaHighDays,
            sla_medium_days: input.slaMediumDays,
            sla_low_days: input.slaLowDays,
            sla_enabled: input.slaEnabled,
            auto_sync_enabled: input.autoSyncEnabled,
            repository_selection_mode: input.repositorySelectionMode,
            selected_repository_ids: input.selectedRepositoryIds,
            model_slug: modelSlug,
            triage_model_slug: triageModelSlug,
            analysis_model_slug: analysisModelSlug,
            analysis_mode: input.analysisMode,
            auto_dismiss_enabled: input.autoDismissEnabled,
            auto_dismiss_confidence_threshold: input.autoDismissConfidenceThreshold,
            auto_analysis_enabled: input.autoAnalysisEnabled,
            auto_analysis_min_severity: input.autoAnalysisMinSeverity,
            auto_analysis_include_existing: input.autoAnalysisIncludeExisting,
            auto_remediation_enabled: input.autoRemediationEnabled,
            auto_remediation_min_severity: input.autoRemediationMinSeverity,
            auto_remediation_include_existing: input.autoRemediationIncludeExisting,
            auto_remediation_require_approval: input.autoRemediationRequireApproval,
            remediation_model_slug: remediationModelSlug,
            sla_notifications_enabled: input.slaNotificationsEnabled,
            sla_notification_min_severity: input.slaNotificationMinSeverity,
            sla_notification_warning_days: input.slaNotificationWarningDays,
            new_finding_notifications_enabled: input.newFindingNotificationsEnabled,
            new_finding_notification_min_severity: input.newFindingNotificationMinSeverity,
          },
          createdBy: ctx.user.id,
          expectedRevision: input.expectedRevision,
          enqueueAnalysis: shouldEnqueueAnalysis
            ? {
                owner: securityOwner,
                minSeverity:
                  input.autoAnalysisMinSeverity ??
                  existingConfig?.config.auto_analysis_min_severity ??
                  'high',
              }
            : undefined,
          enqueueRemediation: shouldEnqueueRemediation ? { owner: securityOwner } : undefined,
        });

        const existingFindingsQueuedCount = saveOutcome.existingFindingsQueuedCount;
        const existingRemediationCommandId = saveOutcome.existingRemediationCommandId;

        // The remediation command row is committed; submit it to the Worker. A
        // submission failure marks the command failed but does not roll back the
        // already-committed config.
        if (existingRemediationCommandId) {
          try {
            await submitApplyAutoRemediation({
              commandId: existingRemediationCommandId,
              owner: securityOwner,
              actorUserId: ctx.user.id,
            });
          } catch (error) {
            console.error('Failed to submit existing findings for remediation', error);
            await markApplyAutoRemediationCommandAdmissionFailed(
              existingRemediationCommandId,
              'Settings saved, but existing exploitable findings could not be queued.'
            );
          }
        }

        trackSecurityAgentConfigSaved({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          autoSyncEnabled: input.autoSyncEnabled,
          analysisMode: input.analysisMode,
          autoDismissEnabled: input.autoDismissEnabled,
          autoDismissConfidenceThreshold: input.autoDismissConfidenceThreshold,
          modelSlug,
          triageModelSlug,
          analysisModelSlug,
          remediationModelSlug,
          autoRemediationEnabled: input.autoRemediationEnabled,
          autoRemediationMinSeverity: input.autoRemediationMinSeverity,
          autoRemediationIncludeExisting: input.autoRemediationIncludeExisting,
          slaEnabled: input.slaEnabled,
          slaNotificationsEnabled: input.slaNotificationsEnabled,
          slaNotificationMinSeverity: input.slaNotificationMinSeverity,
          slaNotificationWarningDays: input.slaNotificationWarningDays,
          newFindingNotificationsEnabled: input.newFindingNotificationsEnabled,
          newFindingNotificationMinSeverity: input.newFindingNotificationMinSeverity,
          repositorySelectionMode: input.repositorySelectionMode,
          selectedRepoCount: input.selectedRepositoryIds?.length,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: SecurityAuditLogAction.ConfigUpdated,
          resource_type: 'agent_config',
          resource_id: resourceId,
          before_state: beforeState,
          after_state: {
            autoSyncEnabled: input.autoSyncEnabled,
            analysisMode: input.analysisMode,
            autoDismissEnabled: input.autoDismissEnabled,
            autoDismissConfidenceThreshold: input.autoDismissConfidenceThreshold,
            autoAnalysisEnabled: input.autoAnalysisEnabled,
            autoAnalysisMinSeverity: input.autoAnalysisMinSeverity,
            autoAnalysisIncludeExisting: input.autoAnalysisIncludeExisting,
            autoRemediationEnabled: input.autoRemediationEnabled,
            autoRemediationMinSeverity: input.autoRemediationMinSeverity,
            autoRemediationIncludeExisting: input.autoRemediationIncludeExisting,
            modelSlug,
            triageModelSlug,
            analysisModelSlug,
            remediationModelSlug,
            repositorySelectionMode: input.repositorySelectionMode,
            selectedRepositoryIds: input.selectedRepositoryIds,
            slaCriticalDays: input.slaCriticalDays,
            slaHighDays: input.slaHighDays,
            slaMediumDays: input.slaMediumDays,
            slaLowDays: input.slaLowDays,
            slaEnabled: input.slaEnabled,
            slaNotificationsEnabled: input.slaNotificationsEnabled,
            slaNotificationMinSeverity: input.slaNotificationMinSeverity,
            slaNotificationWarningDays: input.slaNotificationWarningDays,
            newFindingNotificationsEnabled: input.newFindingNotificationsEnabled,
            newFindingNotificationMinSeverity: input.newFindingNotificationMinSeverity,
          },
        });

        return {
          success: true,
          existingFindingsQueuedCount,
          existingRemediationCommandId,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 4. setEnabled
    // -----------------------------------------------------------------------
    setEnabled: {
      inputSchema: SetEnabledInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: SetEnabledInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const resourceId = deps.resolveResourceId(ctx, input);

        // Get integration (needed for both permission check and sync)
        const integration = await deps.getIntegration(ctx, input);

        // Check permissions before enabling
        if (input.isEnabled) {
          if (!integration || !hasSecurityReviewPermissions(integration)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'GitHub App does not have vulnerability_alerts permission',
            });
          }
        }

        // Determine repository selection
        const existingConfig = await getSecurityAgentConfigWithStatus(owner);
        const selectionMode =
          input.repositorySelectionMode ??
          existingConfig?.config.repository_selection_mode ??
          'selected';
        const selectedIds =
          input.selectedRepositoryIds ?? existingConfig?.config.selected_repository_ids ?? [];

        // Refuse enabling with an empty effective repo set: no repository would
        // be synced or analyzed, so an enabled state would be misleading.
        if (input.isEnabled) {
          const effectiveRepos = getRepoFullNamesInScope(integration, {
            repository_selection_mode: selectionMode,
            selected_repository_ids: selectedIds,
          });
          if (effectiveRepos.length === 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Select at least one repository before enabling Security Agent.',
            });
          }
        }

        // Always upsert the config when enabling to ensure it exists with the correct selection
        if (input.isEnabled) {
          await upsertSecurityAgentConfig(
            owner,
            {
              repository_selection_mode: selectionMode,
              selected_repository_ids: selectedIds,
            },
            ctx.user.id
          );
        }

        await setSecurityAgentEnabled(owner, input.isEnabled);

        // When enabling, trigger an initial sync of repositories
        if (input.isEnabled && integration) {
          const installationId = integration.platform_installation_id;
          if (installationId) {
            const allRepos = requireNumericPlatformRepositories(integration.repositories) ?? [];

            let repositoriesToSync: string[];

            if (selectionMode === 'all') {
              repositoriesToSync = allRepos
                .map(r => r.full_name)
                .filter((name): name is string => !!name);
            } else {
              repositoriesToSync = allRepos
                .filter(r => selectedIds.includes(r.id))
                .map(r => r.full_name)
                .filter((name): name is string => !!name);
            }

            if (repositoriesToSync.length > 0) {
              let initialSync: Awaited<ReturnType<typeof submitManualSecuritySync>> | undefined;
              let initialSyncAdmissionFailed = false;
              try {
                initialSync = await submitManualSecuritySync({
                  owner: securityOwner,
                  actor: {
                    id: ctx.user.id,
                    email: ctx.user.google_user_email,
                    name: ctx.user.google_user_name,
                  },
                  origin: 'enable_initial_sync',
                });
              } catch (error) {
                initialSyncAdmissionFailed = true;
                console.error('Security Agent enabled but initial sync admission failed', error);
              }

              trackSecurityAgentEnabled({
                distinctId: ctx.user.id,
                userId: ctx.user.id,
                ...deps.trackingExtras(ctx, input),
                isEnabled: input.isEnabled,
                repositorySelectionMode: selectionMode,
                selectedRepoCount: repositoriesToSync.length,
              });

              logSecurityAudit({
                owner: securityOwner,
                actor_id: ctx.user.id,
                actor_email: ctx.user.google_user_email,
                actor_name: ctx.user.google_user_name,
                action: SecurityAuditLogAction.ConfigEnabled,
                resource_type: 'agent_config',
                resource_id: resourceId,
                after_state: { isEnabled: true, repositorySelectionMode: selectionMode },
              });

              return {
                success: true,
                initialSync,
                initialSyncAdmissionFailed,
              };
            }
          }
        }

        const effectiveRepoCount =
          selectionMode === 'all'
            ? (integration?.repositories || []).filter(r => !!r.full_name).length
            : selectedIds.length;

        trackSecurityAgentEnabled({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          isEnabled: input.isEnabled,
          repositorySelectionMode: selectionMode,
          selectedRepoCount: effectiveRepoCount,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: input.isEnabled
            ? SecurityAuditLogAction.ConfigEnabled
            : SecurityAuditLogAction.ConfigDisabled,
          resource_type: 'agent_config',
          resource_id: resourceId,
          after_state: { isEnabled: input.isEnabled, repositorySelectionMode: selectionMode },
        });

        return { success: true };
      },
    },

    // -----------------------------------------------------------------------
    // 5. getRepositories
    // -----------------------------------------------------------------------
    getRepositories: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const integration = await deps.getIntegration(ctx, extra);

      if (!integration || integration.integration_status !== 'active') {
        return [];
      }

      // Auto-fetch repositories from GitHub if not cached
      let repos = requireNumericPlatformRepositories(integration.repositories) ?? [];
      if (repos.length === 0 && integration.platform_installation_id) {
        const appType = integration.github_app_type || 'standard';
        const fetchedRepos = await fetchGitHubRepositories(
          integration.platform_installation_id,
          appType
        );
        await updateRepositoriesForIntegration(integration.id, fetchedRepos);
        repos = fetchedRepos;
      }

      const repositoryDetails = repos.map(repo => ({
        id: repo.id,
        fullName: repo.full_name,
        name: repo.name,
        private: repo.private,
      }));
      const installationId = integration.platform_installation_id;
      if (!installationId || !hasSecurityReviewPermissions(integration)) {
        return repositoryDetails.map(repository => ({
          ...repository,
          dependabotAlerts: 'unknown' as const,
        }));
      }

      const appType = integration.github_app_type || 'standard';
      let availability: Awaited<ReturnType<typeof checkDependabotAlertsAvailability>>;
      try {
        availability = await checkDependabotAlertsAvailability(
          installationId,
          appType,
          repositoryDetails
        );
      } catch (error) {
        console.error('Failed to check Dependabot alerts availability', {
          error: error instanceof Error ? error.message : String(error),
        });
        return repositoryDetails.map(repository => ({
          ...repository,
          dependabotAlerts: 'unknown' as const,
        }));
      }
      const availabilityById = new Map(availability.map(result => [result.id, result.status]));

      return repositoryDetails.map(repository => ({
        ...repository,
        dependabotAlerts: availabilityById.get(repository.id) ?? ('unknown' as const),
      }));
    },

    // -----------------------------------------------------------------------
    // 6. listFindings
    // -----------------------------------------------------------------------
    listFindings: {
      inputSchema: ListFindingsInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: ListFindingsInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        const { findings, totalCount } = await listSecurityFindings({
          owner: securityOwner,
          repoFullName: input.repoFullName,
          status: input.status,
          severity: input.severity,
          outcomeFilter: input.outcomeFilter,
          overdue: input.overdue,
          sortBy: input.sortBy,
          limit: input.limit,
          offset: input.offset,
        });

        const concurrencyCheck = await canStartAnalysis(securityOwner);
        const [configWithStatus, integration] = await Promise.all([
          getSecurityAgentConfigWithStatus(owner),
          deps.getIntegration(ctx, input),
        ]);
        const config = configWithStatus?.config ?? DEFAULT_SECURITY_AGENT_CONFIG;
        const decoratedFindings = await decorateFindingsWithRemediation({
          findings,
          config,
          isAgentEnabled: configWithStatus?.isEnabled ?? false,
          repoFullNamesInScope: getRepoFullNamesInScope(integration, config),
        });

        return {
          findings: decoratedFindings.map(toFindingListItem),
          totalCount,
          runningCount: concurrencyCheck.currentCount,
          concurrencyLimit: concurrencyCheck.limit,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 7. getFinding
    // -----------------------------------------------------------------------
    getFinding: {
      inputSchema: GetFindingInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetFindingInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const finding = await getSecurityFindingById(input.id);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        const [configWithStatus, integration] = await Promise.all([
          getSecurityAgentConfigWithStatus(owner),
          deps.getIntegration(ctx, input),
        ]);
        const config = configWithStatus?.config ?? DEFAULT_SECURITY_AGENT_CONFIG;
        return decorateFindingWithRemediation({
          finding,
          config,
          isAgentEnabled: configWithStatus?.isEnabled ?? false,
          repoFullNamesInScope: getRepoFullNamesInScope(integration, config),
        });
      },
    },

    // -----------------------------------------------------------------------
    // 8. getStats
    // -----------------------------------------------------------------------
    getStats: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);
      return await getSecurityFindingsSummary({ owner: securityOwner });
    },

    // -----------------------------------------------------------------------
    // 9. getLastSyncTime
    // -----------------------------------------------------------------------
    getLastSyncTime: {
      inputSchema: ListFindingsInputSchema.pick({ repoFullName: true }),
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: Pick<ListFindingsInput, 'repoFullName'> & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const lastSyncTime = await getLastSyncTimeDb({
          owner: securityOwner,
          repoFullName: input.repoFullName,
        });
        return { lastSyncTime };
      },
    },

    // -----------------------------------------------------------------------
    // 10. triggerSync
    // -----------------------------------------------------------------------
    triggerSync: {
      inputSchema: TriggerSyncInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: TriggerSyncInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const resourceId = deps.resolveResourceId(ctx, input);

        // Get integration
        const integration = await deps.getIntegration(ctx, input);
        if (!integration || integration.integration_status !== 'active') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub integration not found or inactive',
          });
        }

        // Check permissions
        if (!hasSecurityReviewPermissions(integration)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub App does not have vulnerability_alerts permission',
          });
        }

        const installationId = integration.platform_installation_id;
        if (!installationId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub installation ID not found',
          });
        }

        const allRepos = requireNumericPlatformRepositories(integration.repositories) ?? [];

        // Resolve the sync scope (a specific repo, or every enabled repo).
        let syncScope:
          | { syncType: 'single_repo'; repoCount: number; repoFullName: string }
          | { syncType: 'all_repos'; repoCount: number };
        if (input.repoFullName) {
          const hasRepo = allRepos.some(r => r.full_name === input.repoFullName);
          if (!hasRepo) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Repository not found in your GitHub integration',
            });
          }
          syncScope = {
            syncType: 'single_repo',
            repoCount: 1,
            repoFullName: input.repoFullName,
          };
        } else {
          const config = await getSecurityAgentConfigWithStatus(owner);
          const selectionMode = config?.config.repository_selection_mode ?? 'selected';
          const selectedIds = config?.config.selected_repository_ids ?? [];

          const repositoriesToSync: string[] =
            selectionMode === 'all'
              ? allRepos.map(r => r.full_name).filter((name): name is string => !!name)
              : allRepos
                  .filter(r => selectedIds.includes(r.id))
                  .map(r => r.full_name)
                  .filter((name): name is string => !!name);

          if (repositoriesToSync.length === 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'No repositories configured for security reviews',
            });
          }
          syncScope = { syncType: 'all_repos', repoCount: repositoriesToSync.length };
        }

        const submitParams = {
          owner: securityOwner,
          actor: {
            id: ctx.user.id,
            email: ctx.user.google_user_email,
            name: ctx.user.google_user_name,
          },
          origin: 'dashboard_refresh' as const,
          repoFullName: input.repoFullName,
          operationKey: input.operationKey,
        };

        // With an `operationKey`, admit a `security`-domain ledger row before
        // submitting (P1-A-08e). A replayed settled duplicate returns the
        // recorded correlation ids without re-triggering tracking or audit.
        const result: SecurityCommandResult =
          input.operationKey === undefined
            ? { kind: 'accepted', accepted: await submitManualSecuritySync(submitParams) }
            : await runSecurityLedgerSubmit({
                ctx,
                owner: securityOwner,
                intent: 'manual_sync',
                operationKey: input.operationKey,
                resourceKey: securitySyncLedgerResourceKey(securityOwner, input.repoFullName),
                submit: () => submitManualSecuritySync(submitParams),
              });
        if (result.kind === 'replayed') {
          return replayedSecurityResponse(result.canonical);
        }

        trackSecurityAgentSync({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          syncType: syncScope.syncType,
          repoCount: syncScope.repoCount,
          synced: 0,
          errors: 0,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: SecurityAuditLogAction.SyncTriggered,
          resource_type: 'agent_config',
          resource_id: resourceId,
          metadata: {
            syncType: syncScope.syncType,
            ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
            repoCount: syncScope.repoCount,
            runId: result.accepted.runId,
            messageId: result.accepted.messageId,
            status: 'accepted',
          },
        });

        return {
          success: true,
          ...result.accepted,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 11. dismissFinding
    // -----------------------------------------------------------------------
    dismissFinding: {
      inputSchema: DismissFindingInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: DismissFindingInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        // Get the finding
        const finding = await getSecurityFindingById(input.findingId);
        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        // Verify ownership
        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        // Get integration for GitHub API call
        const integration = await deps.getIntegration(ctx, input);
        if (!integration || integration.integration_status !== 'active') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub integration not found or inactive',
          });
        }

        const installationId = integration.platform_installation_id;
        if (!installationId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub installation ID not found',
          });
        }

        const submitParams = {
          owner: securityOwner,
          actor: { id: ctx.user.id, email: ctx.user.google_user_email },
          findingId: input.findingId,
          installationId,
          reason: input.reason,
          comment: input.comment,
          operationKey: input.operationKey,
        };

        // With an `operationKey`, admit a `security`-domain ledger row before
        // submitting (P1-A-08e). A replayed settled duplicate returns the
        // recorded correlation ids without re-triggering tracking.
        const result: SecurityCommandResult =
          input.operationKey === undefined
            ? { kind: 'accepted', accepted: await submitManualFindingDismissal(submitParams) }
            : await runSecurityLedgerSubmit({
                ctx,
                owner: securityOwner,
                intent: 'dismiss_finding',
                operationKey: input.operationKey,
                resourceKey: securityDismissLedgerResourceKey(
                  securityOwner,
                  input.findingId,
                  input.reason,
                  input.comment
                ),
                submit: () => submitManualFindingDismissal(submitParams),
              });
        if (result.kind === 'replayed') {
          return replayedSecurityResponse(result.canonical);
        }

        trackSecurityAgentFindingDismissed({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          findingId: input.findingId,
          reason: input.reason,
          source: finding.source,
          severity: finding.severity,
        });

        return { success: true, ...result.accepted };
      },
    },

    // -----------------------------------------------------------------------
    // 12. startAnalysis
    // -----------------------------------------------------------------------
    startAnalysis: {
      inputSchema: StartAnalysisInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: StartAnalysisInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        const finding = await getSecurityFindingById(input.findingId);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        // Verify ownership
        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        if (input.restartActive && finding.analysis_status !== 'running') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only a running Sandbox Analysis can be restarted',
          });
        }

        if (!input.restartActive) {
          const concurrencyCheck = await canStartAnalysis(securityOwner);

          if (!concurrencyCheck.allowed) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: `Maximum concurrent analyses reached (${concurrencyCheck.currentCount}/${concurrencyCheck.limit}). Please wait for existing analyses to complete.`,
            });
          }
        }

        // Analysis has no client `operationKey`, so each start attempt gets a
        // fresh UUID key. The ledger row is admitted before submission and the
        // Worker `commandId` is recorded as the provider reference, which the
        // web observation settle later joins on to emit
        // `security_command_settled` with the `start_analysis` intent.
        const result: SecurityCommandResult = await runSecurityLedgerSubmit({
          ctx,
          owner: securityOwner,
          intent: 'start_analysis',
          operationKey: crypto.randomUUID(),
          resourceKey: securityAnalysisLedgerResourceKey(securityOwner, input.findingId),
          submit: async () => {
            const { commandId } = await submitManualAnalysisStart({
              findingId: input.findingId,
              owner: securityOwner,
              actorUserId: ctx.user.id,
              requestedModels: {
                model: input.model,
                triageModel: input.triageModel,
                analysisModel: input.analysisModel,
              },
              forceSandbox: input.forceSandbox,
              retrySandboxOnly: input.retrySandboxOnly,
              restartActive: input.restartActive,
            });
            return { accepted: true, commandId };
          },
        });

        if (result.kind === 'replayed') {
          const commandId =
            typeof result.canonical.commandId === 'string' ? result.canonical.commandId : undefined;
          return { success: true, queued: true, commandId };
        }
        return { success: true, queued: true, commandId: result.accepted.commandId };
      },
    },

    // -----------------------------------------------------------------------
    // 13. startRemediation
    // -----------------------------------------------------------------------
    startRemediation: {
      inputSchema: StartRemediationInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: StartRemediationInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const finding = await getSecurityFindingById(input.findingId);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        const queued = await submitManualRemediationStart({
          findingId: input.findingId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
        });
        if (!queued.queued) return { success: false, ...queued };

        // Admit the remediation ledger row after the attempt committed so the
        // Worker's terminal callback can settle it. Best-effort: the attempt
        // already exists, so a ledger write failure must not fail the request.
        await admitSecurityRemediationLedgerRow({
          owner: securityOwner,
          findingId: input.findingId,
          attemptId: queued.attemptId,
          remediationId: queued.remediationId,
          attemptNumber: queued.attemptNumber,
        });

        trackSecurityAgentRemediationAction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          action: 'start',
        });

        return { success: true, ...queued };
      },
    },

    // -----------------------------------------------------------------------
    // 14. retryRemediation
    // -----------------------------------------------------------------------
    retryRemediation: {
      inputSchema: RetryRemediationInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: RetryRemediationInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const finding = await getSecurityFindingById(input.findingId);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        const queued = await submitManualRemediationStart({
          findingId: input.findingId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
          retry: true,
        });
        if (!queued.queued) return { success: false, ...queued };

        await admitSecurityRemediationLedgerRow({
          owner: securityOwner,
          findingId: input.findingId,
          attemptId: queued.attemptId,
          remediationId: queued.remediationId,
          attemptNumber: queued.attemptNumber,
        });

        trackSecurityAgentRemediationAction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          action: 'retry',
        });

        return { success: true, ...queued };
      },
    },

    // -----------------------------------------------------------------------
    // 15. cancelRemediation
    // -----------------------------------------------------------------------
    cancelRemediation: {
      inputSchema: CancelRemediationInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: CancelRemediationInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const result = await submitRemediationCancellation({
          attemptId: input.attemptId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
        });

        trackSecurityAgentRemediationAction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          action: 'cancel',
        });

        return result;
      },
    },

    // -----------------------------------------------------------------------
    // 16. getAnalysis
    // -----------------------------------------------------------------------
    getAnalysis: {
      inputSchema: GetAnalysisInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetAnalysisInput & TExtra;
      }) => {
        const input = rawInput;
        const finding = await getSecurityFindingById(input.findingId);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        // Verify ownership
        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        const owner = deps.resolveOwner(ctx, input);
        const [configWithStatus, integration, remediationAttempts, remediationTimeline] =
          await Promise.all([
            getSecurityAgentConfigWithStatus(owner),
            deps.getIntegration(ctx, input),
            getRemediationAttemptHistory(input.findingId),
            getRemediationTimeline(input.findingId),
          ]);
        const config = configWithStatus?.config ?? DEFAULT_SECURITY_AGENT_CONFIG;
        const decoratedFinding = await decorateFindingWithRemediation({
          finding,
          config,
          isAgentEnabled: configWithStatus?.isEnabled ?? false,
          repoFullNamesInScope: getRepoFullNamesInScope(integration, config),
        });

        return {
          findingState: {
            status: finding.status,
            ignoredReason: finding.ignored_reason,
            ignoredBy: finding.ignored_by,
            fixedAt: finding.fixed_at,
            updatedAt: finding.updated_at,
          },
          status: finding.analysis_status,
          startedAt: finding.analysis_started_at,
          completedAt: finding.analysis_completed_at,
          error: finding.analysis_error,
          analysis: finding.analysis,
          sessionId: finding.session_id,
          cliSessionId: finding.cli_session_id,
          remediationSummary: decoratedFinding.remediationSummary ?? null,
          remediationCapability: decoratedFinding.remediationCapability,
          remediationAttempts,
          remediationTimeline,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 17. getCommandStatus
    // -----------------------------------------------------------------------
    getCommandStatus: {
      inputSchema: GetCommandStatusInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetCommandStatusInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const command = await getSecurityAgentCommandStatus(securityOwner, input.commandId);
        if (!command) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Security Agent command not found' });
        }
        await settleSecurityLedgerForTerminalCommand({ ctx, command });
        return command;
      },
    },

    // -----------------------------------------------------------------------
    // getCommandStatuses (batch)
    // -----------------------------------------------------------------------
    // Compatibility: getCommandStatus (single) kept for older mobile clients; remove when all shipped clients call getCommandStatuses.
    getCommandStatuses: {
      inputSchema: GetCommandStatusesInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetCommandStatusesInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const commands = await getSecurityAgentCommandStatuses(securityOwner, input.commandIds);
        for (const command of commands) {
          await settleSecurityLedgerForTerminalCommand({ ctx, command });
        }
        return commands;
      },
    },

    // -----------------------------------------------------------------------
    // 18. listActiveCommands
    // -----------------------------------------------------------------------
    listActiveCommands: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      return listActiveSecurityAgentCommands(deps.resolveSecurityOwner(ctx, extra));
    },

    // -----------------------------------------------------------------------
    // 19. getOrphanedRepositories
    // -----------------------------------------------------------------------
    getOrphanedRepositories: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);

      // Get the current GitHub integration
      const integration = await deps.getIntegration(ctx, extra);

      // Get list of accessible repository full names
      const accessibleRepoFullNames: string[] = [];
      if (integration && integration.integration_status === 'active') {
        const repos = requireNumericPlatformRepositories(integration.repositories) ?? [];
        for (const repo of repos) {
          if (repo.full_name) {
            accessibleRepoFullNames.push(repo.full_name);
          }
        }
      }

      // Get orphaned repositories with finding counts
      const orphanedRepos = await getOrphanedRepositoriesWithFindingCounts({
        owner: securityOwner,
        accessibleRepoFullNames,
      });

      return orphanedRepos;
    },

    // -----------------------------------------------------------------------
    // 15. deleteFindingsByRepository
    // -----------------------------------------------------------------------
    deleteFindingsByRepository: {
      inputSchema: DeleteFindingsByRepoInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: DeleteFindingsByRepoInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        const result = await deleteFindingsByRepositoryDb({
          owner: securityOwner,
          repoFullName: input.repoFullName,
          actor: buildSecurityFindingAuditHumanActor({
            id: ctx.user.id,
            email: ctx.user.google_user_email,
            name: ctx.user.google_user_name,
            isAdmin: ctx.user.is_admin,
          }),
        });

        return {
          success: true,
          deletedCount: result.deletedCount,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 16. getAutoDismissEligible
    // -----------------------------------------------------------------------
    getAutoDismissEligible: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);
      const result = await countEligibleForAutoDismiss(securityOwner, ctx.user.id);

      return {
        eligible: result.eligible,
        byConfidence: result.byConfidence,
      };
    },

    // -----------------------------------------------------------------------
    // 17. autoDismissEligible
    // -----------------------------------------------------------------------
    autoDismissEligible: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);
      const result = await autoDismissEligibleFindings(
        securityOwner,
        buildSecurityFindingAuditHumanActor({
          id: ctx.user.id,
          email: ctx.user.google_user_email,
          name: ctx.user.google_user_name,
          isAdmin: ctx.user.is_admin,
        })
      );

      return {
        dismissed: result.dismissed,
        skipped: result.skipped,
        errors: result.errors,
      };
    },

    // -----------------------------------------------------------------------
    // 18. getAuditReport
    // -----------------------------------------------------------------------
    getAuditReport: {
      inputSchema: SecurityAgentAuditReportInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: SecurityAgentAuditReportInput & TExtra;
      }) => {
        return assembleAuditReportResponse({
          ctx,
          input: rawInput,
          deps,
        });
      },
    },

    // -----------------------------------------------------------------------
    // 19. getDashboardStats
    // -----------------------------------------------------------------------
    getDashboardStats: {
      inputSchema: GetDashboardStatsInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetDashboardStatsInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const owner = deps.resolveOwner(ctx, input);

        // Get config for SLA targets
        const config = await getSecurityAgentConfigWithStatus(owner);
        const slaConfig = {
          slaCriticalDays: config?.config.sla_critical_days ?? 15,
          slaHighDays: config?.config.sla_high_days ?? 30,
          slaMediumDays: config?.config.sla_medium_days ?? 45,
          slaLowDays: config?.config.sla_low_days ?? 90,
        };

        return getDashboardStats({
          owner: securityOwner,
          repoFullName: input.repoFullName,
          slaEnabled: config?.config.sla_enabled ?? true,
          slaConfig,
        });
      },
    },
  };
}
