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
      isBriefingVisible(report, now) &&
      Date.parse(report.morningEndAt) > now &&
      !dismissedReportIds.includes(report.id)
  );
}

export function briefingSummaryStatusKey(status: string): string {
  switch (status) {
    case 'disabled': {
      return 'agentBriefing.summaryUnavailable';
    }
    case 'pending':
    case 'running': {
      return 'agentBriefing.summaryPending';
    }
    case 'ready': {
      return 'agentBriefing.summary';
    }
    case 'failed': {
      return 'agentBriefing.snapshotSummaryFailed';
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
      return 'agentBriefing.snapshotEstimateInputTooLarge';
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

/**
 * The phase one brief read renders in. Each state is a literal, so a screen
 * switches on it and renders exactly one branch; a set of booleans read beside
 * the data is the implicit state machine the State Machines rule forbids.
 *
 * `offline` is its own phase because an offline-paused first fetch stays
 * pending forever: `isPending` alone cannot tell a slow network from a fetch
 * that will not start, so connectivity is the discriminator. The detail screen
 * renders this whole union; the list screen's settled-no-data state is `empty`
 * instead of `failed` ({@link BriefingListPhase}).
 */
export type BriefingDetailPhase = 'loading' | 'offline' | 'denied' | 'missing' | 'failed' | 'ready';

export type BriefingListPhase = 'loading' | 'offline' | 'denied' | 'failed' | 'empty' | 'ready';

type BriefingReadSignals = {
  /** A brief or preferences object the cache holds, so data can render now. */
  readonly hasData: boolean;
  readonly offline: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly accessDenied: boolean;
};

/**
 * The shared precedence of a brief read, in the one order the phases can claim
 * their signals:
 *
 * 1. cached data is `ready`, whatever the live flags say — a read the cache can
 *    answer keeps rendering it while offline, refetching or retrying;
 * 2. `offline` beats a pending fetch (which never starts), a denial and a
 *    transient failure, so the screen says why it is waiting;
 * 3. `denied` beats the remaining signals: the abandoned pending read settles as
 *    FORBIDDEN, and only that phase's copy tells the person what happened;
 * 4. a pending fetch is `loading`;
 * 5. anything else without data is `failed` — a settled read that answered
 *    neither data nor a denial offers the retry the screen can start.
 */
function briefingReadPhase(signals: BriefingReadSignals): Exclude<BriefingDetailPhase, 'missing'> {
  if (signals.hasData) {
    return 'ready';
  }
  if (signals.offline) {
    return 'offline';
  }
  if (signals.accessDenied) {
    return 'denied';
  }
  if (signals.isPending) {
    return 'loading';
  }
  return 'failed';
}

/**
 * The list screen's phase. Data first, then offline, denial and loading, as
 * {@link briefingReadPhase} orders them; a settled list with no reports and no
 * error is `empty`, the one phase whose copy invites a first brief.
 */
export function selectBriefingListPhase(input: {
  readonly hasReports: boolean;
  readonly offline: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly accessDenied: boolean;
}): BriefingListPhase {
  const phase = briefingReadPhase({ ...input, hasData: input.hasReports });
  if (phase !== 'failed') {
    return phase;
  }
  return input.isError ? 'failed' : 'empty';
}

/**
 * The detail screen's phase. Precedence of {@link briefingReadPhase}, plus
 * `missing` ahead of loading: a report the server says is gone (expired,
 * deleted, or whose sources were removed) needs its own copy, never a retry
 * loop or a permission claim.
 */
export function selectBriefingDetailPhase(input: {
  readonly hasReport: boolean;
  readonly offline: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly accessDenied: boolean;
  readonly missing: boolean;
}): BriefingDetailPhase {
  if (!input.hasReport && !input.offline && !input.accessDenied && input.missing) {
    return 'missing';
  }
  return briefingReadPhase({ ...input, hasData: input.hasReport });
}

/**
 * The settings screen's phase: the same precedence over the preferences read,
 * which has no empty state — settled without data is a failure to retry, and a
 * report cannot be missing here.
 */
export function selectBriefingSettingsPhase(input: {
  readonly hasPreferences: boolean;
  readonly offline: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly accessDenied: boolean;
}): Exclude<BriefingDetailPhase, 'missing'> {
  return briefingReadPhase({ ...input, hasData: input.hasPreferences });
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

/**
 * A number as a person typed it in this language, or null when the language's
 * own grammar cannot read it exactly.
 *
 * `parseLocalizedNumber` strips every group separator, so a separator the
 * grammar does not place there is ambiguous: German `2.5` would read as 25,
 * and a pasted `1,234.50` would read as 1.2345 while the field keeps showing
 * the text. The integer part is therefore checked against the grouping this
 * language's own formatter produces, which also covers languages that group
 * three digits and then pairs (`hi`, `ta`), and space separators typed where
 * the language formats a narrow no-break space.
 */
function readSafeguardAmount(text: string, locale: string): number | null {
  const format = numberFormat(locale, { useGrouping: true });
  const parts = format.formatToParts(-12_345.6);
  const group = parts.find(item => item.type === 'group')?.value;
  const decimal = parts.find(item => item.type === 'decimal')?.value ?? '.';
  const normalized = (
    group !== undefined && /^\s$/u.test(group) ? text.replaceAll(/[\s\u00A0\u202F]/gu, group) : text
  ).trim();
  const trimmed = normalized.replace(/^[+-]/, '');
  const fields = trimmed.split(decimal);
  const [whole = '', fraction] = fields;
  if (fields.length > 2) {
    return null;
  }
  if (fraction !== undefined && !/^\p{Nd}*$/u.test(fraction)) {
    return null;
  }
  const value = parseLocalizedNumber(normalized, locale);
  if (value === null) {
    return null;
  }
  if (whole === '') {
    return fraction ? value : null;
  }
  if (group === undefined || !whole.includes(group)) {
    return /^\p{Nd}+$/u.test(whole) ? value : null;
  }
  // A grouped integer is only unambiguous when the language's decimal
  // separator follows it: `1.234` alone is a whole number in one convention
  // and a fraction in another.
  if (
    fraction === undefined ||
    !/^\p{Nd}+$/u.test(whole.split(group).join('')) ||
    whole
      .split(group)
      .map(part => part.length)
      .join(',') !==
      format
        // Only the integer part: a fraction long enough to round across a
        // group boundary would otherwise disagree with the typed integer.
        .formatToParts(Math.trunc(Math.abs(value)))
        .filter(part => part.type === 'integer')
        .map(part => part.value.length)
        .join(',')
  ) {
    return null;
  }
  return value;
}

/**
 * The two safeguard fields as a person typed them in the active language: a
 * decimal comma in `de` is the decimal separator, not a bad value. Text the
 * language's number grammar cannot read leaves the fields invalid, and the
 * existing inline message says so, so a value is never silently rescaled.
 */
export function parseBriefingSafeguardInput(
  minutes: string,
  dollars: string,
  locale: string
): BriefingSafeguards | null {
  const duration = readSafeguardAmount(minutes, locale);
  const spend = readSafeguardAmount(dollars, locale);
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
