import { type BriefingReport, isBriefingVisible } from '@kilocode/app-shared/agent-briefing';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { parseLocalizedNumber } from '@/lib/format';
import { numberFormat } from '@/lib/intl-cache';
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
      report.kind !== 'one_off' &&
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
    case 'input_too_large': {
      return 'agentBriefing.estimateInputTooLarge';
    }
    case 'permission_unavailable': {
      return 'agentBriefing.estimatePermissionUnavailable';
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

const DIGIT = String.raw`\p{Nd}`;

function escapeLiteral(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * One number written in this language's grammar: digits, one optional decimal
 * separator, and group separators only between three-digit groups after the
 * decimal separator. A group separator is accepted only when the language's
 * own decimal separator follows it, because `1.234` alone is a whole number in
 * one convention and a fraction in another.
 */
function localizedNumberPattern(locale: string): RegExp {
  const parts = numberFormat(locale, { useGrouping: true }).formatToParts(123_456.7);
  const part = (type: Intl.NumberFormatPartTypes, fallback: string) =>
    parts.find(item => item.type === type)?.value ?? fallback;
  const group = parts.find(item => item.type === 'group')?.value;
  const decimal = escapeLiteral(part('decimal', '.'));
  const plain = `${DIGIT}+(?:${decimal}${DIGIT}*)?|${decimal}${DIGIT}+`;
  const grouped = group
    ? `|(?:${DIGIT}{1,3}(?:${escapeLiteral(group)}${DIGIT}{3})+)${decimal}${DIGIT}*`
    : '';
  return new RegExp(`^[+-]?(?:${plain}${grouped})$`, 'u');
}

/**
 * The two safeguard fields as a person typed them in the active language: a
 * decimal comma in `de` is the decimal separator, not a bad value. Text the
 * language's number grammar cannot read leaves the fields invalid.
 *
 * `parseLocalizedNumber` strips every group separator, so a separator the
 * grammar does not place there is ambiguous: German `2.5` would read as 25,
 * and a pasted `1,234.50` would read as 1.2345 while the field keeps showing
 * the text. Validate the whole text against the grammar first, and show the
 * existing invalid message instead, so a value is never silently rescaled.
 */
export function parseBriefingSafeguardInput(
  minutes: string,
  dollars: string,
  locale: string
): BriefingSafeguards | null {
  const pattern = localizedNumberPattern(locale);
  const field = (text: string) =>
    pattern.test(text.trim()) ? parseLocalizedNumber(text, locale) : null;
  const duration = field(minutes);
  const spend = field(dollars);
  if (duration === null || spend === null) {
    return null;
  }
  return parseBriefingSafeguards(duration, spend);
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
