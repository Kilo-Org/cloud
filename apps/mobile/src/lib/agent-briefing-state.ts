import { type BriefingReport, isBriefingVisible } from '@kilocode/app-shared/agent-briefing';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

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
