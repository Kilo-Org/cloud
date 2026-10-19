import { type BriefingReport, isBriefingVisible } from '@kilocode/app-shared/agent-briefing';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { readTrpcErrorField } from '@/lib/trpc-error';

type BriefingMembership = Pick<
  inferRouterOutputs<MobileRouter>['organizations']['list'][number],
  'organizationId' | 'role'
>;

export function readableBriefingOrganizationIds(
  memberships: readonly BriefingMembership[]
): string[] {
  return memberships.filter(org => org.role !== 'billing_manager').map(org => org.organizationId);
}

export function canReadBriefingContext(
  organizationId: string | null,
  authenticated: boolean,
  organizationIds: readonly string[]
): boolean {
  return authenticated && (organizationId === null || organizationIds.includes(organizationId));
}

export function visibleHomeBriefing(
  reports: readonly BriefingReport[],
  organizationId: string | null,
  { dismissedReportIds, now }: { dismissedReportIds: readonly string[]; now: number }
): BriefingReport | undefined {
  return reports.find(
    report =>
      report.context.organizationId === organizationId &&
      isBriefingVisible(report, now) &&
      Date.parse(report.morningEndAt) > now &&
      !dismissedReportIds.includes(report.id)
  );
}

export function briefingSummaryStatusKey(status: string): string {
  switch (status) {
    case 'disabled': {
      return 'agentBriefing.summaryDisabled';
    }
    case 'pending':
    case 'running': {
      return 'agentBriefing.summaryPending';
    }
    case 'ready': {
      return 'agentBriefing.summary';
    }
    case 'failed': {
      return 'agentBriefing.summaryFailed';
    }
    case 'outdated': {
      return 'agentBriefing.summaryOutdated';
    }
    default: {
      return 'agentBriefing.summaryUnavailable';
    }
  }
}

export function briefingEstimateUnavailableKey(reason: string | null | undefined): string {
  switch (reason) {
    case 'model_pricing_unavailable':
    case 'invalid_model_pricing': {
      return 'agentBriefing.estimatePricingUnavailable';
    }
    case 'balance_unavailable': {
      return 'agentBriefing.estimateBalanceUnavailable';
    }
    case 'model_not_allowed': {
      return 'agentBriefing.estimateModelNotAllowed';
    }
    case 'spend_limit_too_low': {
      return 'agentBriefing.estimateSpendLimitTooLow';
    }
    case null:
    case undefined: {
      return 'agentBriefing.estimateUnavailable';
    }
    default: {
      return 'agentBriefing.estimateUnavailable';
    }
  }
}

/** The server rejects a context's access (role, membership or sign-in), never a mere missing report. */
export function briefingAccessDenied(error: unknown): boolean {
  const code = readTrpcErrorField(error, 'code');
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
}

/**
 * A report older than 30 days, deleted, owned by someone else, or whose sources
 * were removed answers NOT_FOUND. That is a neutral missing-report state, not a
 * loss of access, so it never clears the read cache.
 */
export function briefingReportMissing(error: unknown): boolean {
  return readTrpcErrorField(error, 'code') === 'NOT_FOUND';
}

/** `agentBriefing.safeguardInput`: whole seconds, 1 to 600, and a positive safe-integer spend. */
const MAX_BRIEFING_DURATION_SECONDS = 600;

export type BriefingSafeguards = { maxDurationSeconds: number; maxSpendMicrodollars: number };

export function parseBriefingSafeguards(
  minutes: number,
  dollars: number
): BriefingSafeguards | null {
  const maxDurationSeconds = Math.round(minutes * 60);
  const maxSpendMicrodollars = Math.round(dollars * 1_000_000);
  const valid =
    Number.isFinite(minutes) &&
    Number.isFinite(dollars) &&
    maxDurationSeconds >= 1 &&
    maxDurationSeconds <= MAX_BRIEFING_DURATION_SECONDS &&
    maxSpendMicrodollars > 0 &&
    Number.isSafeInteger(maxSpendMicrodollars);
  return valid ? { maxDurationSeconds, maxSpendMicrodollars } : null;
}

const SYNC_RETRY_DELAYS_MS = [0, 2000, 8000] as const;

/**
 * How long to wait before the next dismissal-journal sync attempt after this
 * many consecutive failures, or null once the attempts are exhausted. The
 * count resets on a foreground or reconnect, so a stuck store never spins.
 */
export function briefingSyncDelayMs(failures: number): number | null {
  return SYNC_RETRY_DELAYS_MS[failures] ?? null;
}
