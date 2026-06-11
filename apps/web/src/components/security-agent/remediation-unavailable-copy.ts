const REMEDIATION_UNAVAILABLE_COPY: Record<string, string> = {
  finding_not_open: 'Finding is no longer open.',
  repo_not_in_scope: 'Repository is not selected for Security Agent.',
  analysis_required: 'Run codebase analysis before starting remediation.',
  sandbox_analysis_required: 'Run codebase analysis before starting remediation.',
  stale_analysis: 'Finding changed after analysis. Rerun analysis before starting remediation.',
  not_exploitable: 'Analysis marked this finding not exploitable in this repository.',
  exploitability_unknown:
    'Analysis could not confirm exploitability. Manual review is required before one-click remediation.',
  manual_review_required:
    'Analysis recommends manual review, so one-click remediation is unavailable.',
  monitor_required: 'Analysis recommends monitoring instead of opening a PR.',
  triage_only: 'Only triage has completed. Run codebase analysis before starting remediation.',
  action_not_concrete: 'Analysis did not return a concrete PR fix path.',
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
};

export function getRemediationUnavailableCopy(reason: string | null | undefined): string | null {
  if (!reason || reason === 'eligible') return null;
  return REMEDIATION_UNAVAILABLE_COPY[reason] ?? 'Remediation is unavailable for this finding.';
}
