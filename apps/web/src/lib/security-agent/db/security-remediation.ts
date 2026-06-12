import { db } from '@/lib/drizzle';
import {
  security_remediations,
  security_remediation_attempts,
  type SecurityFinding,
  type SecurityRemediationAttempt,
} from '@kilocode/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  computeSecurityRemediationAnalysisFingerprint,
  decideSecurityRemediationEligibility,
  type SecurityRemediationCapabilityReason,
  type SecurityRemediationConfig,
} from '@kilocode/worker-utils/security-remediation-policy';
import type { SecurityAgentConfig } from '../core/types';

const ACTIVE_ATTEMPT_STATUSES = ['queued', 'launching', 'running'] as const;
const AUTOMATIC_DEDUPE_STATUSES = [
  'queued',
  'launching',
  'running',
  'pr_opened',
  'blocked',
  'no_changes_needed',
] as const;
const RETRYABLE_TERMINAL_STATUSES = [
  'failed',
  'blocked',
  'no_changes_needed',
  'cancelled',
] as const;

type RemediationAttemptSummary = {
  id: string;
  status: SecurityRemediationAttempt['status'];
  origin: SecurityRemediationAttempt['origin'];
  attemptNumber: number;
  requestedByUserId: string | null;
  remediationModelSlug: string;
  branchName: string;
  prUrl: string | null;
  prNumber: number | null;
  prDraft: boolean | null;
  prHeadBranch: string | null;
  prBaseBranch: string | null;
  failureCode: string | null;
  blockedReason: string | null;
  lastErrorRedacted: string | null;
  validationEvidence: Record<string, unknown>[] | null;
  riskNotes: string | null;
  draftReason: string | null;
  cancellationRequestedAt: string | null;
  queuedAt: string;
  launchedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SecurityRemediationSummary = {
  id: string;
  status: string;
  latestAttemptId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prDraft: boolean | null;
  prHeadBranch: string | null;
  prBaseBranch: string | null;
  failureCode: string | null;
  blockedReason: string | null;
  outcomeSummary: string | null;
  completedAt: string | null;
  updatedAt: string;
  latestAttempt: RemediationAttemptSummary | null;
};

export type SecurityRemediationCapability = {
  canStart: boolean;
  startReason: SecurityRemediationCapabilityReason;
  canRetry: boolean;
  retryReason: SecurityRemediationCapabilityReason;
  canCancel: boolean;
  cancelAttemptId: string | null;
};

export type SecurityFindingWithRemediation = SecurityFinding & {
  remediationSummary: SecurityRemediationSummary | null;
  remediationCapability: SecurityRemediationCapability;
};

type RemediationBlockState = {
  hasActiveAttempt: boolean;
  hasPrOpened: boolean;
  hasAutomaticTerminalForFingerprint: boolean;
  hasRetryableTerminalForFinding: boolean;
};

function toIsoString(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function serializeAttempt(
  attempt: SecurityRemediationAttempt | null | undefined
): RemediationAttemptSummary | null {
  if (!attempt) return null;
  return {
    id: attempt.id,
    status: attempt.status,
    origin: attempt.origin,
    attemptNumber: attempt.attempt_number,
    requestedByUserId: attempt.requested_by_user_id,
    remediationModelSlug: attempt.remediation_model_slug,
    branchName: attempt.branch_name,
    prUrl: attempt.pr_url,
    prNumber: attempt.pr_number,
    prDraft: attempt.pr_draft,
    prHeadBranch: attempt.pr_head_branch,
    prBaseBranch: attempt.pr_base_branch,
    failureCode: attempt.failure_code,
    blockedReason: attempt.blocked_reason,
    lastErrorRedacted: attempt.last_error_redacted,
    validationEvidence: attempt.validation_evidence,
    riskNotes: attempt.risk_notes,
    draftReason: attempt.draft_reason,
    cancellationRequestedAt: toIsoString(attempt.cancellation_requested_at),
    queuedAt: new Date(attempt.queued_at).toISOString(),
    launchedAt: toIsoString(attempt.launched_at),
    completedAt: toIsoString(attempt.completed_at),
    createdAt: new Date(attempt.created_at).toISOString(),
    updatedAt: new Date(attempt.updated_at).toISOString(),
  };
}

export async function getLatestRemediationSummaries(
  findingIds: string[]
): Promise<Map<string, SecurityRemediationSummary>> {
  if (findingIds.length === 0) return new Map();

  const rows = await db
    .select({
      findingId: security_remediations.finding_id,
      remediation: security_remediations,
      attempt: security_remediation_attempts,
    })
    .from(security_remediations)
    .leftJoin(
      security_remediation_attempts,
      eq(security_remediation_attempts.id, security_remediations.latest_attempt_id)
    )
    .where(inArray(security_remediations.finding_id, findingIds));

  const summaries = new Map<string, SecurityRemediationSummary>();
  for (const row of rows) {
    summaries.set(row.findingId, {
      id: row.remediation.id,
      status: row.remediation.status,
      latestAttemptId: row.remediation.latest_attempt_id,
      prUrl: row.remediation.pr_url,
      prNumber: row.remediation.pr_number,
      prDraft: row.remediation.pr_draft,
      prHeadBranch: row.remediation.pr_head_branch,
      prBaseBranch: row.remediation.pr_base_branch,
      failureCode: row.remediation.failure_code,
      blockedReason: row.remediation.blocked_reason,
      outcomeSummary: row.remediation.outcome_summary,
      completedAt: toIsoString(row.remediation.completed_at),
      updatedAt: new Date(row.remediation.updated_at).toISOString(),
      latestAttempt: serializeAttempt(row.attempt),
    });
  }
  return summaries;
}

export async function getRemediationAttemptHistory(
  findingId: string
): Promise<RemediationAttemptSummary[]> {
  const attempts = await db
    .select()
    .from(security_remediation_attempts)
    .where(eq(security_remediation_attempts.finding_id, findingId))
    .orderBy(desc(security_remediation_attempts.attempt_number));

  return attempts.flatMap(attempt => {
    const serialized = serializeAttempt(attempt);
    return serialized ? [serialized] : [];
  });
}

async function getRemediationBlockStates(
  findings: SecurityFinding[]
): Promise<Map<string, RemediationBlockState>> {
  const findingIds = findings.map(finding => finding.id);
  const empty = new Map(
    findings.map(finding => [
      finding.id,
      {
        hasActiveAttempt: false,
        hasPrOpened: false,
        hasAutomaticTerminalForFingerprint: false,
        hasRetryableTerminalForFinding: false,
      },
    ])
  );
  if (findingIds.length === 0) return empty;

  const fingerprints = new Map(
    findings.map(finding => [
      finding.id,
      computeSecurityRemediationAnalysisFingerprint(finding) ?? null,
    ])
  );

  const attempts = await db
    .select({
      findingId: security_remediation_attempts.finding_id,
      status: security_remediation_attempts.status,
      analysisFingerprint: security_remediation_attempts.analysis_fingerprint,
    })
    .from(security_remediation_attempts)
    .where(inArray(security_remediation_attempts.finding_id, findingIds));

  for (const attempt of attempts) {
    const state = empty.get(attempt.findingId);
    if (!state) continue;
    const fingerprint = fingerprints.get(attempt.findingId);
    if ((ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)) {
      state.hasActiveAttempt = true;
    }
    if (attempt.status === 'pr_opened') {
      state.hasPrOpened = true;
    }
    if (
      fingerprint &&
      attempt.analysisFingerprint === fingerprint &&
      (AUTOMATIC_DEDUPE_STATUSES as readonly string[]).includes(attempt.status)
    ) {
      state.hasAutomaticTerminalForFingerprint = true;
    }
    if ((RETRYABLE_TERMINAL_STATUSES as readonly string[]).includes(attempt.status)) {
      state.hasRetryableTerminalForFinding = true;
    }
  }

  return empty;
}

function toPolicyConfig(config: SecurityAgentConfig): SecurityRemediationConfig {
  return {
    repository_selection_mode: config.repository_selection_mode,
    auto_remediation_enabled: config.auto_remediation_enabled,
    auto_remediation_min_severity: config.auto_remediation_min_severity,
    auto_remediation_include_existing: config.auto_remediation_include_existing,
    auto_remediation_enabled_at: config.auto_remediation_enabled_at,
  };
}

export async function decorateFindingsWithRemediation(params: {
  findings: SecurityFinding[];
  config: SecurityAgentConfig;
  isAgentEnabled: boolean;
  repoFullNamesInScope: string[];
}): Promise<SecurityFindingWithRemediation[]> {
  const summaries = await getLatestRemediationSummaries(params.findings.map(finding => finding.id));
  const blockStates = await getRemediationBlockStates(params.findings);
  const policyConfig = toPolicyConfig(params.config);

  return params.findings.map(finding => {
    const blockState = blockStates.get(finding.id) ?? {
      hasActiveAttempt: false,
      hasPrOpened: false,
      hasAutomaticTerminalForFingerprint: false,
      hasRetryableTerminalForFinding: false,
    };
    const startDecision = decideSecurityRemediationEligibility({
      finding,
      config: policyConfig,
      isAgentEnabled: params.isAgentEnabled,
      repoFullNamesInScope: params.repoFullNamesInScope,
      origin: 'manual',
      blockState,
      allowManualRetry: false,
    });
    const retryDecision = decideSecurityRemediationEligibility({
      finding,
      config: policyConfig,
      isAgentEnabled: params.isAgentEnabled,
      repoFullNamesInScope: params.repoFullNamesInScope,
      origin: 'manual',
      blockState,
      allowManualRetry: true,
    });
    const summary = summaries.get(finding.id) ?? null;
    const canCancelStatus =
      summary?.latestAttempt?.status === 'queued' ||
      summary?.latestAttempt?.status === 'launching' ||
      summary?.latestAttempt?.status === 'running';

    return {
      ...finding,
      remediationSummary: summary,
      remediationCapability: {
        canStart: startDecision.eligible && !blockState.hasRetryableTerminalForFinding,
        startReason: startDecision.reason,
        canRetry: retryDecision.eligible && blockState.hasRetryableTerminalForFinding,
        retryReason: retryDecision.reason,
        canCancel: Boolean(canCancelStatus && summary?.latestAttempt?.id),
        cancelAttemptId: canCancelStatus ? (summary?.latestAttempt?.id ?? null) : null,
      },
    };
  });
}

export async function decorateFindingWithRemediation(params: {
  finding: SecurityFinding;
  config: SecurityAgentConfig;
  isAgentEnabled: boolean;
  repoFullNamesInScope: string[];
}): Promise<SecurityFindingWithRemediation> {
  const [decorated] = await decorateFindingsWithRemediation({
    findings: [params.finding],
    config: params.config,
    isAgentEnabled: params.isAgentEnabled,
    repoFullNamesInScope: params.repoFullNamesInScope,
  });
  return decorated;
}
