import {
  type FindingDeadlineState,
  type SecurityFindingAnalysisState,
} from '@kilocode/app-shared/security-agent';

import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { firstNonEmpty } from '@/lib/utils';

// Analysis-state copy keys, translated at render time. English wording must
// match packages/app-shared/src/security-agent/presentation.ts exactly.
const LABEL_KEYS = {
  queued: 'securityAgent.analysisState.queued',
  analyzing: 'securityAgent.analysisState.analyzing',
  failed: 'securityAgent.analysisState.failed',
  'extraction-failed': 'securityAgent.analysisState.unknown',
  exploitable: 'securityAgent.analysis.exploitable',
  'not-exploitable': 'securityAgent.analysisState.notExploitable',
  unknown: 'securityAgent.analysisState.unknown',
  'safe-to-dismiss': 'securityAgent.analysisState.safeToDismiss',
  'manual-review': 'securityAgent.analysisState.unknown',
  'analysis-required': 'securityAgent.analysisState.analysisRequired',
  completed: 'securityAgent.analysis.analyzed',
  'not-analyzed': 'securityAgent.analysisState.notAnalyzed',
} satisfies Record<SecurityFindingAnalysisState, string>;

const TITLE_KEYS = {
  queued: 'securityAgent.analysisState.queued',
  analyzing: 'securityAgent.analysisState.analyzing',
  failed: 'securityAgent.analysisState.failed',
  'extraction-failed': 'securityAgent.analysisState.unknown',
  exploitable: 'securityAgent.analysis.exploitable',
  'not-exploitable': 'securityAgent.analysisState.notExploitable',
  unknown: 'securityAgent.analysisState.unknown',
  'safe-to-dismiss': 'securityAgent.analysisState.safeToDismiss',
  'manual-review': 'securityAgent.analysisState.manualReviewTitle',
  'analysis-required': 'securityAgent.analysisState.analysisRequiredTitle',
  completed: 'securityAgent.analysis.analyzed',
  'not-analyzed': 'securityAgent.analysisState.notAnalyzed',
} satisfies Record<SecurityFindingAnalysisState, string>;

const DESCRIPTION_KEYS = {
  queued: 'securityAgent.analysisState.queuedDescription',
  analyzing: 'securityAgent.analysisState.analyzingDescription',
  failed: 'securityAgent.analysisState.failedDescription',
  'extraction-failed': 'securityAgent.analysisState.extractionFailedDescription',
  exploitable: 'securityAgent.analysisState.exploitableDescription',
  'not-exploitable': 'securityAgent.analysisState.notExploitableDescription',
  unknown: 'securityAgent.analysisState.unknownDescription',
  'safe-to-dismiss': 'securityAgent.analysisState.safeToDismissDescription',
  'manual-review': 'securityAgent.analysisState.manualReviewDescription',
  'analysis-required': 'securityAgent.analysisState.analysisRequiredDescription',
  completed: 'securityAgent.analysisState.completedDescription',
  'not-analyzed': 'securityAgent.analysisState.notAnalyzedDescription',
} satisfies Record<SecurityFindingAnalysisState, string>;

/**
 * Dynamic text that replaces the English fallback for a state, mirroring the
 * firstNonEmpty precedence in presentation.ts. Pass null/undefined to fall
 * back to the translated copy.
 */
type SecurityAnalysisDynamicText = {
  analysisError?: string | null;
  sandboxSummary?: string | null;
  sandboxReasoning?: string | null;
  triageReasoning?: string | null;
};

export function getSecurityAnalysisLabel(state: SecurityFindingAnalysisState): string {
  return i18n.t(LABEL_KEYS[state]);
}

export function getSecurityAnalysisDetailTitle(state: SecurityFindingAnalysisState): string {
  return i18n.t(TITLE_KEYS[state]);
}

export function getSecurityAnalysisDetailDescription(
  state: SecurityFindingAnalysisState,
  dynamic: SecurityAnalysisDynamicText = {}
): string {
  const fallback = i18n.t(DESCRIPTION_KEYS[state]);
  if (state === 'failed') {
    return firstNonEmpty(dynamic.analysisError, fallback);
  }
  if (state === 'exploitable' || state === 'not-exploitable' || state === 'unknown') {
    return firstNonEmpty(dynamic.sandboxSummary, dynamic.sandboxReasoning, fallback);
  }
  if (state === 'safe-to-dismiss' || state === 'manual-review' || state === 'analysis-required') {
    return firstNonEmpty(dynamic.triageReasoning, fallback);
  }
  return fallback;
}

// Catalog keys for the remediation-unavailable reason codes, mapped from
// REMEDIATION_UNAVAILABLE_COPY and getRemediationUnavailableCopy in
// packages/app-shared. Unknown reasons keep the generic copy; a null/eligible
// reason stays null so callers keep their existing fallback.
const REMEDIATION_UNAVAILABLE_KEYS = {
  finding_not_found: 'securityAgent.remediationUnavailable.findingNotFound',
  approval_required: 'securityAgent.remediationUnavailable.approvalRequired',
  finding_not_open: 'securityAgent.remediationUnavailable.findingNotOpen',
  repo_not_in_scope: 'securityAgent.remediationUnavailable.repoNotInScope',
  analysis_required: 'securityAgent.remediationUnavailable.analysisRequired',
  sandbox_analysis_required: 'securityAgent.remediationUnavailable.analysisRequired',
  stale_analysis: 'securityAgent.remediationUnavailable.staleAnalysis',
  not_exploitable: 'securityAgent.remediationUnavailable.notExploitable',
  exploitability_unknown: 'securityAgent.remediationUnavailable.exploitabilityUnknown',
  manual_review_required: 'securityAgent.remediationUnavailable.manualReviewRequired',
  monitor_required: 'securityAgent.remediationUnavailable.monitorRequired',
  triage_only: 'securityAgent.remediationUnavailable.triageOnly',
  action_not_concrete: 'securityAgent.remediationUnavailable.actionNotConcrete',
  remediation_active: 'securityAgent.remediationUnavailable.remediationActive',
  pr_already_opened: 'securityAgent.remediationUnavailable.prAlreadyOpened',
  duplicate_analysis_result: 'securityAgent.remediationUnavailable.duplicateAnalysisResult',
  retry_not_allowed: 'securityAgent.remediationUnavailable.retryNotAllowed',
  security_agent_disabled: 'securityAgent.remediationUnavailable.securityAgentDisabled',
  auto_remediation_disabled: 'securityAgent.remediationUnavailable.autoRemediationDisabled',
  include_existing_disabled: 'securityAgent.remediationUnavailable.includeExistingDisabled',
  below_threshold: 'securityAgent.remediationUnavailable.belowThreshold',
  before_enablement: 'securityAgent.remediationUnavailable.beforeEnablement',
} as const satisfies Record<string, string>;

const REMEDIATION_UNAVAILABLE_GENERIC_KEY = 'securityAgent.remediation.unavailable';

export function getRemediationUnavailableKey(reason: string | null | undefined): string | null {
  if (!reason || reason === 'eligible') {
    return null;
  }
  // Object.hasOwn (not `in`) so inherited keys like 'constructor' fall
  // through to the generic copy instead of leaking prototype members.
  return Object.hasOwn(REMEDIATION_UNAVAILABLE_KEYS, reason)
    ? REMEDIATION_UNAVAILABLE_KEYS[reason as keyof typeof REMEDIATION_UNAVAILABLE_KEYS]
    : REMEDIATION_UNAVAILABLE_GENERIC_KEY;
}

type DeadlineCopy = { label: string; detail: string };

// Renders the deadline from its stable state code, never from the English
// label/detail the shared module built (web still reads those). Dates use the
// active app language via formatDate.
export function getDeadlineCopy(state: FindingDeadlineState): DeadlineCopy {
  switch (state.kind) {
    case 'fixed': {
      const label = state.beforeDeadline
        ? i18n.t('securityAgent.deadline.fixedBeforeDeadline')
        : i18n.t('securityAgent.filter.fixed');
      const detail = state.fixedAt
        ? i18n.t('securityAgent.deadline.fixedOn', {
            date: formatDate(state.fixedAt, i18n.language),
          })
        : i18n.t('securityAgent.deadline.resolutionRecorded');
      return { label, detail };
    }
    case 'closed': {
      const status = state.superseded
        ? i18n.t('securityAgent.deadline.superseded')
        : i18n.t('common.dismissed');
      return {
        label: status,
        detail: i18n.t('securityAgent.deadline.closedOn', {
          status,
          date: formatDate(state.at, i18n.language),
        }),
      };
    }
    case 'no-deadline': {
      return {
        label: i18n.t('securityAgent.deadline.deadlineNotSet'),
        detail: i18n.t('securityAgent.deadline.noSlaDeadline'),
      };
    }
    case 'overdue': {
      return {
        label:
          state.days === 0
            ? i18n.t('securityAgent.deadline.overdueNow')
            : i18n.t('securityAgent.deadline.overdue', { count: state.days }),
        detail: i18n.t('securityAgent.deadline.dueOn', {
          date: formatDate(state.deadline, i18n.language),
        }),
      };
    }
    case 'due-today': {
      return {
        label: i18n.t('securityAgent.deadline.dueToday'),
        detail: i18n.t('securityAgent.deadline.dueOn', {
          date: formatDate(state.deadline, i18n.language),
        }),
      };
    }
    case 'due-tomorrow': {
      return {
        label: i18n.t('securityAgent.deadline.dueTomorrow'),
        detail: i18n.t('securityAgent.deadline.dueOn', {
          date: formatDate(state.deadline, i18n.language),
        }),
      };
    }
    case 'due-in': {
      return {
        label: i18n.t('securityAgent.deadline.dueInDays', { count: state.days }),
        detail: i18n.t('securityAgent.deadline.dueOn', {
          date: formatDate(state.deadline, i18n.language),
        }),
      };
    }
    default: {
      return {
        label: i18n.t('securityAgent.deadline.deadlineNotSet'),
        detail: i18n.t('securityAgent.deadline.noSlaDeadline'),
      };
    }
  }
}
