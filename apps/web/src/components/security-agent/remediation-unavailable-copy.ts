// SecurityRemediationAdmissionRejectionReason (from worker-utils) is a subset
// of the string values getRemediationUnavailableCopy accepts — every caller
// passes one of its members, or the 'eligible' sentinel handled below.
import { getRemediationUnavailableCopy as getSharedRemediationUnavailableCopy } from '@kilocode/app-shared/security-agent';

export function isCodebaseAnalysisRequiredReason(reason: string | null | undefined): boolean {
  return (
    reason === 'analysis_required' ||
    reason === 'sandbox_analysis_required' ||
    reason === 'triage_only'
  );
}

export function getRemediationUnavailableCopy(reason: string | null | undefined): string | null {
  return getSharedRemediationUnavailableCopy(reason);
}
