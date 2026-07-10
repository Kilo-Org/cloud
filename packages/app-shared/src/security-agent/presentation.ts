/* eslint-disable max-lines -- single UI-framework-free presentation module for the
   whole security-agent surface (list/deadline + details/analysis/remediation);
   splitting it would scatter one ported semantic mapping across files. */
import { firstNonEmpty, parseTimestamp } from '../utils';

// Ported from apps/web/src/components/security-agent/security-finding-list-presentation.ts,
// FindingDetailDialog.tsx, and remediation-unavailable-copy.ts. The web
// grid-class helper (getFindingListGridClass) is web-only layout CSS and
// intentionally not ported, along with web's hero/summary/action/steps
// narrative structures — this module returns plain text/tone/icon-key data.

export type FindingTone = 'success' | 'warning' | 'danger' | 'neutral';

// Icon KEYS, not React elements — finding-row.tsx maps these to
// lucide-react-native components so this module stays UI-framework-free.
export type FindingIconKey =
  | 'loader'
  | 'x-circle'
  | 'eye'
  | 'shield-alert'
  | 'shield-check'
  | 'shield'
  | 'brain'
  | 'check-circle'
  | 'clock'
  | 'alert-triangle';

type FindingStatusPresentation = {
  label: string;
  tone: FindingTone;
  icon: FindingIconKey;
  spinning?: boolean;
  tooltip?: string | null;
};

type FindingDeadlinePresentation = FindingStatusPresentation & { detail: string };

// Structural shape of a finding's `analysis` column — permissive so it's
// satisfied by both web's SecurityFinding (from @kilocode/db/schema) and
// mobile's tRPC RouterOutputs['securityAgent']['getFinding'].
export type SecurityFindingAnalysis = {
  sandboxAnalysis?: {
    extractionStatus?: 'succeeded' | 'failed';
    isExploitable: boolean | 'unknown';
    summary: string;
    exploitabilityReasoning: string;
  };
  triage?: {
    suggestedAction: 'dismiss' | 'analyze_codebase' | 'manual_review';
    needsSandboxReasoning: string;
  };
};

// Structural shape of a security finding — only the fields this module
// reads, kept permissive so both web's DB row type and mobile's tRPC output
// type satisfy it.
export type SecurityFinding = {
  status: string;
  analysis_status: string | null;
  analysis: SecurityFindingAnalysis | null;
  analysis_error: string | null;
  ignored_reason: string | null;
  fixed_at: string | null;
  sla_due_at: string | null;
  updated_at: string;
};

export type SecurityFindingAnalysisState =
  | 'queued'
  | 'analyzing'
  | 'failed'
  | 'extraction-failed'
  | 'exploitable'
  | 'not-exploitable'
  | 'unknown'
  | 'safe-to-dismiss'
  | 'manual-review'
  | 'analysis-required'
  | 'completed'
  | 'not-analyzed';

export function getSecurityFindingAnalysisState(
  analysisStatus: string | null,
  analysis: SecurityFinding['analysis']
): SecurityFindingAnalysisState {
  if (analysisStatus === 'pending') {
    return 'queued';
  }
  if (analysisStatus === 'running') {
    return 'analyzing';
  }
  if (analysisStatus === 'failed') {
    return 'failed';
  }

  const sandbox = analysis?.sandboxAnalysis;
  if (sandbox?.extractionStatus === 'failed') {
    return 'extraction-failed';
  }
  if (sandbox?.isExploitable === true) {
    return 'exploitable';
  }
  if (sandbox?.isExploitable === false) {
    return 'not-exploitable';
  }
  if (sandbox?.isExploitable === 'unknown') {
    return 'unknown';
  }

  const triage = analysis?.triage;
  if (triage?.suggestedAction === 'dismiss') {
    return 'safe-to-dismiss';
  }
  if (triage?.suggestedAction === 'manual_review') {
    return 'manual-review';
  }
  if (triage) {
    return 'analysis-required';
  }
  if (analysisStatus === 'completed') {
    return 'completed';
  }
  return 'not-analyzed';
}

export function getSecurityAnalysisPresentation(
  finding: SecurityFinding
): FindingStatusPresentation {
  const analysisState = getSecurityFindingAnalysisState(finding.analysis_status, finding.analysis);
  const sandbox = finding.analysis?.sandboxAnalysis;
  const triage = finding.analysis?.triage;

  switch (analysisState) {
    case 'queued': {
      return {
        icon: 'loader',
        label: 'Analysis queued',
        tone: 'warning',
        spinning: true,
        tooltip: 'Analysis is queued',
      };
    }
    case 'analyzing': {
      return {
        icon: 'loader',
        label: 'Analyzing',
        tone: 'warning',
        spinning: true,
        tooltip: 'Analysis is running',
      };
    }
    case 'failed': {
      return {
        icon: 'x-circle',
        label: 'Analysis failed',
        tone: 'danger',
        tooltip: firstNonEmpty(finding.analysis_error, 'Analysis failed. Retry to run it again.'),
      };
    }
    case 'extraction-failed': {
      return {
        icon: 'eye',
        label: 'Needs review',
        tone: 'warning',
        tooltip: 'Structured analysis result is unavailable. Review the technical report.',
      };
    }
    case 'exploitable': {
      return {
        icon: 'shield-alert',
        label: 'Exploitable',
        tone: 'danger',
        tooltip: firstNonEmpty(
          sandbox?.summary,
          'Codebase analysis confirmed this vulnerability is exploitable'
        ),
      };
    }
    case 'not-exploitable': {
      return {
        icon: 'shield-check',
        label: 'Unreachable',
        tone: 'success',
        tooltip: firstNonEmpty(
          sandbox?.summary,
          'Codebase analysis found no reachable vulnerable path'
        ),
      };
    }
    case 'unknown': {
      return {
        icon: 'eye',
        label: 'Needs review',
        tone: 'warning',
        tooltip: firstNonEmpty(
          sandbox?.summary,
          sandbox?.exploitabilityReasoning,
          'Analysis could not confirm whether the vulnerable feature is reachable'
        ),
      };
    }
    case 'safe-to-dismiss': {
      return {
        icon: 'shield-check',
        label: 'Safe to dismiss',
        tone: 'success',
        tooltip: firstNonEmpty(
          triage?.needsSandboxReasoning,
          'Triage determined this can be safely dismissed'
        ),
      };
    }
    case 'manual-review': {
      return {
        icon: 'eye',
        label: 'Needs review',
        tone: 'warning',
        tooltip: firstNonEmpty(
          triage?.needsSandboxReasoning,
          'Triage flagged this for manual review'
        ),
      };
    }
    case 'analysis-required': {
      return {
        icon: 'brain',
        label: 'Analysis required',
        tone: 'warning',
        tooltip: firstNonEmpty(triage?.needsSandboxReasoning, 'Codebase analysis is required'),
      };
    }
    case 'completed': {
      return { icon: 'shield', label: 'Analyzed', tone: 'neutral' };
    }
    case 'not-analyzed': {
      return { icon: 'brain', label: 'Not analyzed', tone: 'neutral' };
    }
    default: {
      const exhaustiveCheck: never = analysisState;
      throw new Error(`Unhandled security finding analysis state: ${String(exhaustiveCheck)}`);
    }
  }
}

const SUPERSEDED_PREFIX = 'superseded:';

// Ported from FindingDetailDialog.tsx:272 (getSupersedingFindingId).
export function getSupersedingFindingId(finding: SecurityFinding): string | null {
  if (!finding.ignored_reason?.startsWith(SUPERSEDED_PREFIX)) {
    return null;
  }
  const findingId = finding.ignored_reason.slice(SUPERSEDED_PREFIX.length);
  return findingId || null;
}

function isSupersededFinding(finding: SecurityFinding): boolean {
  return finding.status === 'ignored' && getSupersedingFindingId(finding) !== null;
}

function formatFindingDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Calendar-day difference in the device's local timezone (matches date-fns'
// differenceInCalendarDays semantics) — no date-fns dependency needed for
// this one comparison.
function calendarDaysDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a) - startOfDay(b)) / MS_PER_DAY);
}

export function getSecurityDeadlinePresentation(
  finding: SecurityFinding,
  now = new Date()
): FindingDeadlinePresentation {
  if (finding.status === 'fixed') {
    const fixedAt = finding.fixed_at ? parseTimestamp(finding.fixed_at) : null;
    const deadline = finding.sla_due_at ? parseTimestamp(finding.sla_due_at) : null;
    const fixedBeforeDeadline = Boolean(
      fixedAt && deadline && fixedAt.getTime() <= deadline.getTime()
    );
    return {
      icon: fixedBeforeDeadline ? 'check-circle' : 'clock',
      label: fixedBeforeDeadline ? 'Fixed before deadline' : 'Fixed',
      detail: fixedAt ? `Fixed ${formatFindingDate(fixedAt)}` : 'Resolution recorded',
      tone: fixedBeforeDeadline ? 'success' : 'neutral',
    };
  }

  if (finding.status === 'ignored') {
    const updatedAt = parseTimestamp(finding.updated_at);
    const label = isSupersededFinding(finding) ? 'Superseded' : 'Dismissed';
    return {
      icon: 'clock',
      label,
      detail: `${label} ${formatFindingDate(updatedAt)}`,
      tone: 'neutral',
    };
  }

  if (!finding.sla_due_at) {
    return {
      icon: 'clock',
      label: 'Deadline not set',
      detail: 'No SLA deadline',
      tone: 'neutral',
    };
  }

  const deadline = parseTimestamp(finding.sla_due_at);
  const calendarDays = calendarDaysDiff(deadline, now);
  const detail = `Due ${formatFindingDate(deadline)}`;
  if (deadline.getTime() < now.getTime()) {
    const overdueDays = Math.abs(calendarDays);
    return {
      icon: 'alert-triangle',
      label:
        overdueDays === 0
          ? 'Overdue'
          : `${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} overdue`,
      detail,
      tone: 'danger',
    };
  }
  if (calendarDays === 0) {
    return { icon: 'clock', label: 'Due today', detail, tone: 'warning' };
  }
  if (calendarDays === 1) {
    return { icon: 'clock', label: 'Due tomorrow', detail, tone: 'warning' };
  }
  return {
    icon: 'clock',
    label: `Due in ${calendarDays} days`,
    detail,
    tone: calendarDays <= 3 ? 'warning' : 'neutral',
  };
}

// ---------------------------------------------------------------------------
// Details panel (ported from FindingDetailDialog.tsx:552 and its small
// formatting helpers — condensed to plain label/tone data, no hero/action
// narrative or web layout).
// ---------------------------------------------------------------------------

/** Label/tone pair for facts that don't need an icon (severity, lifecycle status). */
type FindingBadge = { label: string; tone: FindingTone };

export function getFindingSeverityPresentation(severity: string): FindingBadge {
  if (severity === 'critical') {
    return { label: 'Critical', tone: 'danger' };
  }
  if (severity === 'high') {
    return { label: 'High', tone: 'warning' };
  }
  if (severity === 'medium') {
    return { label: 'Medium', tone: 'warning' };
  }
  if (severity === 'low') {
    return { label: 'Low', tone: 'neutral' };
  }
  return { label: severity, tone: 'neutral' };
}

export function getFindingLifecycleStatusPresentation(finding: SecurityFinding): FindingBadge {
  if (getSupersedingFindingId(finding)) {
    return { label: 'Superseded', tone: 'neutral' };
  }
  if (finding.status === 'fixed') {
    return { label: 'Fixed', tone: 'success' };
  }
  if (finding.status === 'ignored') {
    return { label: 'Dismissed', tone: 'neutral' };
  }
  if (finding.status === 'open') {
    return { label: 'Open', tone: 'neutral' };
  }
  return { label: finding.status, tone: 'neutral' };
}

const DISMISSAL_REASON_LABELS: Record<string, string> = {
  fix_started: 'a fix has already started',
  no_bandwidth: 'no bandwidth is available',
  tolerable_risk: 'the risk is tolerable',
  inaccurate: 'the finding is inaccurate',
  not_used: 'vulnerable code is not used',
};

export function getDismissalReasonLabel(reason: string | null): string {
  if (!reason) {
    return 'after review';
  }
  return DISMISSAL_REASON_LABELS[reason] ?? reason.replaceAll('_', ' ');
}

export function getFindingSourceLabel(source: string): string {
  if (source === 'dependabot') {
    return 'GitHub Dependabot';
  }
  return source.replaceAll('_', ' ');
}

// ---------------------------------------------------------------------------
// Analysis panel (ported from FindingDetailDialog.tsx:985 — a single
// title/description/tone/icon object per analysis state rather than the web
// hero/summary/action/steps narrative; action buttons belong to a later task).
// ---------------------------------------------------------------------------

type SecurityAnalysisDetailPresentation = {
  title: string;
  description: string;
  tone: FindingTone;
  icon: FindingIconKey;
  spinning?: boolean;
};

export function getSecurityAnalysisDetailPresentation(
  analysisStatus: string | null,
  analysis: SecurityFinding['analysis'],
  analysisError: string | null
): SecurityAnalysisDetailPresentation {
  const analysisState = getSecurityFindingAnalysisState(analysisStatus, analysis);
  const sandbox = analysis?.sandboxAnalysis;
  const triage = analysis?.triage;

  switch (analysisState) {
    case 'queued': {
      return {
        title: 'Analysis queued',
        description: 'Waiting for analysis capacity to become available.',
        tone: 'warning',
        icon: 'loader',
        spinning: true,
      };
    }
    case 'analyzing': {
      return {
        title: 'Analyzing',
        description: 'Checking whether application code can reach the affected feature.',
        tone: 'warning',
        icon: 'loader',
        spinning: true,
      };
    }
    case 'failed': {
      return {
        title: 'Analysis failed',
        description: firstNonEmpty(
          analysisError,
          'Security Agent could not complete the analysis.'
        ),
        tone: 'danger',
        icon: 'x-circle',
      };
    }
    case 'extraction-failed': {
      return {
        title: 'Needs review',
        description: 'The technical report could not be turned into a structured result.',
        tone: 'warning',
        icon: 'eye',
      };
    }
    case 'exploitable': {
      return {
        title: 'Exploitable',
        description: firstNonEmpty(
          sandbox?.summary,
          sandbox?.exploitabilityReasoning,
          'Application code can reach the affected feature.'
        ),
        tone: 'danger',
        icon: 'shield-alert',
      };
    }
    case 'not-exploitable': {
      return {
        title: 'Unreachable',
        description: firstNonEmpty(
          sandbox?.summary,
          sandbox?.exploitabilityReasoning,
          'No reachable path was found in this repository.'
        ),
        tone: 'success',
        icon: 'shield-check',
      };
    }
    case 'unknown': {
      return {
        title: 'Needs review',
        description: firstNonEmpty(
          sandbox?.summary,
          sandbox?.exploitabilityReasoning,
          'Analysis could not confirm whether the vulnerable feature is reachable.'
        ),
        tone: 'warning',
        icon: 'eye',
      };
    }
    case 'safe-to-dismiss': {
      return {
        title: 'Safe to dismiss',
        description: firstNonEmpty(
          triage?.needsSandboxReasoning,
          'Triage determined this can be safely dismissed without codebase analysis.'
        ),
        tone: 'success',
        icon: 'shield-check',
      };
    }
    case 'manual-review': {
      return {
        title: 'Needs manual review',
        description: firstNonEmpty(
          triage?.needsSandboxReasoning,
          'Triage flagged this finding for manual review.'
        ),
        tone: 'warning',
        icon: 'eye',
      };
    }
    case 'analysis-required': {
      return {
        title: 'Codebase analysis required',
        description: firstNonEmpty(
          triage?.needsSandboxReasoning,
          'Triage recommends analyzing the repository before deciding a response.'
        ),
        tone: 'warning',
        icon: 'brain',
      };
    }
    case 'completed': {
      return {
        title: 'Analyzed',
        description: 'Analysis completed with no specific outcome recorded.',
        tone: 'neutral',
        icon: 'shield',
      };
    }
    case 'not-analyzed': {
      return {
        title: 'Not analyzed',
        description: 'Codebase analysis has not run for this finding yet.',
        tone: 'neutral',
        icon: 'brain',
      };
    }
    default: {
      const exhaustiveCheck: never = analysisState;
      throw new Error(`Unhandled security finding analysis state: ${String(exhaustiveCheck)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Remediation panel (ported from FindingDetailDialog.tsx:1849 and
// remediation-unavailable-copy.ts:6 — the single source for remediation
// status/blocker copy, also imported by use-security-findings.ts).
// ---------------------------------------------------------------------------

export function isActiveRemediationStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'launching' || status === 'running';
}

export function formatRemediationOrigin(origin: string): string {
  if (origin === 'auto_policy') {
    return 'Automatic policy';
  }
  if (origin === 'bulk_existing') {
    return 'Include existing policy';
  }
  if (origin === 'manual') {
    return 'Manual';
  }
  return origin.replaceAll('_', ' ');
}

type RemediationStatusPresentation = FindingStatusPresentation;

export function getRemediationStatusPresentation(
  status: string | null,
  options: { cancellationRequestedAt?: string | null; prDraft?: boolean | null } = {}
): RemediationStatusPresentation {
  if (options.cancellationRequestedAt && isActiveRemediationStatus(status)) {
    return { label: 'Cancellation requested', tone: 'warning', icon: 'loader', spinning: true };
  }
  if (!status) {
    return { label: 'Not started', tone: 'neutral', icon: 'clock' };
  }
  if (status === 'queued') {
    return { label: 'Queued', tone: 'warning', icon: 'loader', spinning: true };
  }
  if (status === 'launching') {
    return { label: 'Starting', tone: 'warning', icon: 'loader', spinning: true };
  }
  if (status === 'running') {
    return { label: 'In progress', tone: 'warning', icon: 'loader', spinning: true };
  }
  if (status === 'pr_opened') {
    return options.prDraft
      ? { label: 'Draft PR opened', tone: 'warning', icon: 'eye' }
      : { label: 'PR opened', tone: 'success', icon: 'check-circle' };
  }
  if (status === 'blocked') {
    return { label: 'Blocked', tone: 'warning', icon: 'alert-triangle' };
  }
  if (status === 'failed') {
    return { label: 'Failed', tone: 'danger', icon: 'x-circle' };
  }
  if (status === 'no_changes_needed') {
    return { label: 'No changes needed', tone: 'neutral', icon: 'check-circle' };
  }
  if (status === 'cancelled') {
    return { label: 'Cancelled', tone: 'neutral', icon: 'x-circle' };
  }
  return { label: status.replaceAll('_', ' '), tone: 'neutral', icon: 'clock' };
}

function getValidationRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function formatValidationEvidenceEntry(
  record: Record<string, unknown>,
  index: number
): string {
  const label =
    getValidationRecordString(record, 'name') ??
    getValidationRecordString(record, 'title') ??
    getValidationRecordString(record, 'command') ??
    getValidationRecordString(record, 'check') ??
    `Validation check ${index + 1}`;
  const result =
    getValidationRecordString(record, 'result') ??
    getValidationRecordString(record, 'status') ??
    getValidationRecordString(record, 'summary');
  return result ? `${label}: ${result}` : label;
}

// Ported verbatim from remediation-unavailable-copy.ts:6-33. Mobile doesn't
// depend on @kilocode/worker-utils, so the reason union is derived locally
// from this table's own keys rather than importing
// SecurityRemediationAdmissionRejectionReason — this table is still the only
// copy in the mobile tree (use-security-findings.ts imports it from here).
const REMEDIATION_UNAVAILABLE_COPY = {
  finding_not_found: 'Security finding no longer exists.',
  finding_not_open: 'Finding is no longer open.',
  repo_not_in_scope: 'Repository is not selected for Security Agent.',
  analysis_required: 'Run codebase analysis before starting remediation.',
  sandbox_analysis_required: 'Run codebase analysis before starting remediation.',
  stale_analysis: 'Finding changed after analysis. Rerun analysis before starting remediation.',
  not_exploitable: 'Analysis found no reachable vulnerable path. Auto Remediation is unavailable.',
  exploitability_unknown:
    'Analysis could not confirm exploitability. Manual review is required before one-click remediation.',
  manual_review_required:
    'Analysis recommends manual review, so one-click remediation is unavailable.',
  monitor_required: 'Analysis recommends monitoring instead of opening a PR.',
  triage_only: 'Only triage has completed. Run codebase analysis before starting remediation.',
  action_not_concrete: 'No concrete dependency patch or suggested fix is available.',
  remediation_active: 'A remediation attempt is already active.',
  pr_already_opened: 'A remediation PR is already open.',
  duplicate_analysis_result: 'This analysis result already produced remediation work.',
  retry_not_allowed: 'Retry is not available for this attempt.',
  security_agent_disabled: 'Security Agent is disabled for this owner.',
  auto_remediation_disabled:
    'Auto Remediation is disabled. Manual remediation can still start when safety gates pass.',
  include_existing_disabled: 'Existing findings are excluded from automatic remediation.',
  below_threshold:
    'Finding is below automatic severity threshold. Manual remediation can still start when safety gates pass.',
  before_enablement:
    'Analysis completed before Auto Remediation was enabled. Manual remediation can still start when safety gates pass.',
} as const;

type RemediationUnavailableReason = keyof typeof REMEDIATION_UNAVAILABLE_COPY;

export function getRemediationUnavailableCopy(reason: string | null | undefined): string | null {
  if (!reason || reason === 'eligible') {
    return null;
  }
  // Object.hasOwn (not `in`) so inherited keys like 'constructor' fall
  // through to the generic copy instead of leaking prototype members.
  return Object.hasOwn(REMEDIATION_UNAVAILABLE_COPY, reason)
    ? REMEDIATION_UNAVAILABLE_COPY[reason as RemediationUnavailableReason]
    : 'Remediation is unavailable for this finding.';
}
