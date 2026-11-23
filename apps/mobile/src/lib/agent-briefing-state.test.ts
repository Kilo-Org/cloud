import { type BriefingReport } from '@kilocode/app-shared/agent-briefing';
import { describe, expect, it } from 'vitest';

import {
  briefingAccessDenied,
  briefingDurationSeconds,
  briefingEstimateUnavailableKey,
  briefingReportMissing,
  type BriefingSafeguardField,
  type BriefingSafeguardInput,
  briefingSpendMicrodollars,
  briefingSummaryStatusKey,
  briefingSyncDelayMs,
  canReadBriefingContext,
  parseBriefingSafeguardInput,
  readableBriefingOrganizationIds,
  visibleHomeBriefing,
} from './agent-briefing-state';

const now = Date.parse('2026-10-15T09:00:00Z');
const report: BriefingReport = {
  id: 'report-1',
  createdAt: '2026-10-15T08:00:00Z',
  capturedAt: '2026-10-15T08:00:00Z',
  truncated: false,
  timezone: 'UTC',
  context: { id: 'personal', organizationId: null, name: 'Personal' },
  localDate: '2026-10-15',
  nightStartAt: '2026-10-14T22:00:00Z',
  cutoffAt: '2026-10-15T08:00:00Z',
  morningEndAt: '2026-10-15T12:00:00Z',
  publishedAt: '2026-10-15T08:00:00Z',
  updatedAt: '2026-10-15T08:00:00Z',
  expiresAt: '2026-10-15T12:00:00Z',
  readAt: null,
  dismissedAt: null,
  scorecard: { sessions: 2, pullRequests: 1, blockers: 0 },
  coverage: { activity: 'partial', pullRequests: 'partial', blockers: 'partial' },
  sessions: [],
  sources: [],
  summary: {
    status: 'disabled',
    text: null,
    model: null,
    costMicrodollars: 0,
    chargeStatus: 'settled',
    estimatedCostMicrodollars: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  },
};

describe('visibleHomeBriefing', () => {
  it('shows an active meaningful report only in its own context', () => {
    expect(visibleHomeBriefing([report], null, { dismissedReportIds: [], now })).toBe(report);
    expect(
      visibleHomeBriefing([report], 'organization-1', { dismissedReportIds: [], now })
    ).toBeUndefined();
  });

  it('honors offline dismissal without requiring a server response', () => {
    expect(
      visibleHomeBriefing([report], null, { dismissedReportIds: ['report-1'], now })
    ).toBeUndefined();
    expect(
      visibleHomeBriefing([{ ...report, dismissedAt: '2026-10-15T08:30:00Z' }], null, {
        dismissedReportIds: [],
        now,
      })
    ).toBeUndefined();
  });

  it('restores live status at morning end even if a cached expiry is later', () => {
    const cached = { ...report, expiresAt: '2026-10-16T12:00:00Z' };
    expect(
      visibleHomeBriefing([cached], null, {
        dismissedReportIds: [],
        now: Date.parse(report.morningEndAt),
      })
    ).toBeUndefined();
  });

  it('does not expose unpublished or empty reports', () => {
    expect(
      visibleHomeBriefing([{ ...report, publishedAt: null }], null, { dismissedReportIds: [], now })
    ).toBeUndefined();
    expect(
      visibleHomeBriefing([{ ...report, scorecard: { ...report.scorecard, sessions: 0 } }], null, {
        dismissedReportIds: [],
        now,
      })
    ).toBeUndefined();
  });
});

describe('briefing context access', () => {
  it('rejects billing-only membership after a role downgrade while the organization ID remains', () => {
    const before = readableBriefingOrganizationIds([{ organizationId: 'org-1', role: 'member' }]);
    const after = readableBriefingOrganizationIds([
      { organizationId: 'org-1', role: 'billing_manager' },
    ]);
    expect(before).toEqual(['org-1']);
    expect(after).toEqual([]);
    expect(canReadBriefingContext('org-1', true, after)).toBe(false);
    expect(before.some(id => !after.includes(id))).toBe(true);
  });

  it('refuses cached personal and organization content during sign-out', () => {
    expect(canReadBriefingContext(null, false, ['org-1'])).toBe(false);
    expect(canReadBriefingContext('org-1', false, ['org-1'])).toBe(false);
  });

  it('blocks a revoked or unresolved organization without blocking Personal', () => {
    expect(canReadBriefingContext('org-1', true, [])).toBe(false);
    expect(canReadBriefingContext('org-1', true, ['org-2'])).toBe(false);
    expect(canReadBriefingContext(null, true, [])).toBe(true);
  });

  it('permits only a currently accessible organization', () => {
    expect(canReadBriefingContext('org-1', true, ['org-1'])).toBe(true);
  });
});

describe('briefingEstimateUnavailableKey', () => {
  it('explains each actionable estimate refusal and falls back for others', () => {
    expect(briefingEstimateUnavailableKey('invalid_model_pricing')).toBe(
      'agentBriefing.estimatePricingUnavailable'
    );
    expect(briefingEstimateUnavailableKey('balance_unavailable')).toBe(
      'agentBriefing.estimateBalanceUnavailable'
    );
    expect(briefingEstimateUnavailableKey('model_not_allowed')).toBe(
      'agentBriefing.estimateModelNotAllowed'
    );
    expect(briefingEstimateUnavailableKey('spend_limit_too_low')).toBe(
      'agentBriefing.estimateSpendLimitTooLow'
    );
    expect(briefingEstimateUnavailableKey('input_too_large')).toBe(
      'agentBriefing.snapshotEstimateInputTooLarge'
    );
    expect(briefingEstimateUnavailableKey('permission_unavailable')).toBe(
      'agentBriefing.estimatePermissionUnavailable'
    );
    expect(briefingEstimateUnavailableKey('gateway_declined')).toBe(
      'agentBriefing.estimateUnavailable'
    );
    expect(briefingEstimateUnavailableKey(null)).toBe('agentBriefing.estimateUnavailable');
  });
});

describe('briefingSummaryStatusKey', () => {
  it('names a skipped summary not_admitted instead of a generic failure', () => {
    expect(briefingSummaryStatusKey('failed', 'not_admitted')).toBe(
      'agentBriefing.summaryNotAdmitted'
    );
    expect(briefingSummaryStatusKey('unavailable', 'not_admitted')).toBe(
      'agentBriefing.summaryNotAdmitted'
    );
  });

  it('keeps a failed or timed-out summary a failure, and status alone unchanged', () => {
    expect(briefingSummaryStatusKey('failed', 'time_limit')).toBe(
      'agentBriefing.snapshotSummaryFailed'
    );
    expect(briefingSummaryStatusKey('failed')).toBe('agentBriefing.snapshotSummaryFailed');
    expect(briefingSummaryStatusKey('failed', null)).toBe('agentBriefing.snapshotSummaryFailed');
    expect(briefingSummaryStatusKey('unavailable')).toBe('agentBriefing.summaryUnavailable');
    expect(briefingSummaryStatusKey('disabled')).toBe('agentBriefing.summaryUnavailable');
    expect(briefingSummaryStatusKey('pending')).toBe('agentBriefing.summaryPending');
    expect(briefingSummaryStatusKey('running')).toBe('agentBriefing.summaryPending');
    expect(briefingSummaryStatusKey('ready')).toBe('agentBriefing.summary');
    expect(briefingSummaryStatusKey('failed', 'gateway_declined')).toBe(
      'agentBriefing.snapshotSummaryFailed'
    );
  });
});

const trpcError = (code: string) => ({ data: { code } });

describe('missing report versus lost access', () => {
  it('treats NOT_FOUND as a neutral missing report that never clears the read cache', () => {
    expect(briefingReportMissing(trpcError('NOT_FOUND'))).toBe(true);
    expect(briefingAccessDenied(trpcError('NOT_FOUND'))).toBe(false);
  });

  it('treats FORBIDDEN and UNAUTHORIZED as lost access, and nothing else', () => {
    expect(briefingAccessDenied(trpcError('FORBIDDEN'))).toBe(true);
    expect(briefingAccessDenied(trpcError('UNAUTHORIZED'))).toBe(true);
    expect(briefingReportMissing(trpcError('FORBIDDEN'))).toBe(false);
    expect(briefingAccessDenied(trpcError('INTERNAL_SERVER_ERROR'))).toBe(false);
    expect(briefingAccessDenied(new Error('offline'))).toBe(false);
  });
});

describe('briefing safeguard ranges', () => {
  it('accepts the server range: whole seconds from 1 to 600 and a positive spend', () => {
    expect(briefingDurationSeconds(10)).toBe(600);
    expect(briefingDurationSeconds(1 / 60)).toBe(1);
    expect(briefingSpendMicrodollars(2)).toBe(2_000_000);
    expect(briefingSpendMicrodollars(0.5)).toBe(500_000);
  });

  it('rejects a duration the server would refuse', () => {
    expect(briefingDurationSeconds(10.1)).toBeNull();
    expect(briefingDurationSeconds(60)).toBeNull();
    expect(briefingDurationSeconds(0)).toBeNull();
    expect(briefingDurationSeconds(-1)).toBeNull();
  });

  it('rejects a non-finite or non-positive spend', () => {
    expect(briefingSpendMicrodollars(0)).toBeNull();
    expect(briefingSpendMicrodollars(Number.NaN)).toBeNull();
    expect(briefingSpendMicrodollars(Number.POSITIVE_INFINITY)).toBeNull();
    expect(briefingSpendMicrodollars(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

/** The expected result of a pair the card must mark, one entry per field at fault. */
function invalidSafeguards(...fields: BriefingSafeguardField[]): BriefingSafeguardInput {
  return { kind: 'invalid', fields };
}

/** The expected result of a pair the server would accept. */
function validSafeguards(
  maxDurationSeconds: number,
  maxSpendMicrodollars: number
): BriefingSafeguardInput {
  return { kind: 'valid', limits: { maxDurationSeconds, maxSpendMicrodollars } };
}

describe('parseBriefingSafeguardInput', () => {
  it('reads the decimal separator of the active language', () => {
    expect(parseBriefingSafeguardInput('2,5', '2,5', 'de')).toEqual(
      validSafeguards(150, 2_500_000)
    );
    expect(parseBriefingSafeguardInput('10', '2.5', 'en')).toEqual(validSafeguards(600, 2_500_000));
  });

  it('names the field that failed, duration before spend', () => {
    expect(parseBriefingSafeguardInput('0', '2', 'en')).toEqual(invalidSafeguards('duration'));
    // Readable, but above the server's 600-second ceiling.
    expect(parseBriefingSafeguardInput('11', '2', 'en')).toEqual(invalidSafeguards('duration'));
    expect(parseBriefingSafeguardInput('10', '0', 'en')).toEqual(invalidSafeguards('spend'));
    expect(parseBriefingSafeguardInput('zwei', 'zwei', 'de')).toEqual(
      invalidSafeguards('duration', 'spend')
    );
  });

  it('rejects text the fields cannot turn into a server-valid limit', () => {
    expect(parseBriefingSafeguardInput('', '2,5', 'de')).toEqual(invalidSafeguards('duration'));
    expect(parseBriefingSafeguardInput('2,5', '', 'de')).toEqual(invalidSafeguards('spend'));
    expect(parseBriefingSafeguardInput('zwei', '2,5', 'de')).toEqual(invalidSafeguards('duration'));
    expect(parseBriefingSafeguardInput('2,5', '-1', 'de')).toEqual(invalidSafeguards('spend'));
  });

  it('refuses a separator the active language does not read as a decimal point', () => {
    // Each case pairs the refused text with a valid value in the other field, so
    // the grammar check is the only reason the result is invalid: without it the
    // text would still turn into a server-valid limit.
    expect(parseBriefingSafeguardInput('5', '2.5', 'de')).toEqual(invalidSafeguards('spend'));
    expect(parseBriefingSafeguardInput('0.5', '1', 'de')).toEqual(invalidSafeguards('duration'));
    expect(parseBriefingSafeguardInput('5', '2,5', 'en')).toEqual(invalidSafeguards('spend'));
  });

  it('refuses a group separator on the wrong side of the decimal separator', () => {
    // Pasted from another convention: German grammar reads the comma as the
    // decimal separator, so the trailing ".50" cannot be a group.
    expect(parseBriefingSafeguardInput('10', '1,234.50', 'de')).toEqual(invalidSafeguards('spend'));
    expect(parseBriefingSafeguardInput('10', '1.234.5', 'de')).toEqual(invalidSafeguards('spend'));
    expect(parseBriefingSafeguardInput('10', '1,23.50', 'en')).toEqual(invalidSafeguards('spend'));
  });

  it('accepts the language its own display writes', () => {
    expect(parseBriefingSafeguardInput('10', '1234,5', 'de')).toEqual(
      validSafeguards(600, 1_234_500_000)
    );
    expect(parseBriefingSafeguardInput('10', '1.234,5', 'de')).toEqual(
      validSafeguards(600, 1_234_500_000)
    );
    expect(parseBriefingSafeguardInput('10', '1,234.5', 'en')).toEqual(
      validSafeguards(600, 1_234_500_000)
    );
  });

  it('follows the grouping and separator the active language formats', () => {
    // Pairing groups of two then three is correct in these languages and wrong
    // in English, where the same text must be refused.
    expect(parseBriefingSafeguardInput('10', '1,23,456.7', 'hi')).toEqual(
      validSafeguards(600, 123_456_700_000)
    );
    expect(parseBriefingSafeguardInput('10', '123,456.7', 'hi')).toEqual(
      invalidSafeguards('spend')
    );
    // French formats a narrow no-break space; a typed plain space reads the same.
    expect(parseBriefingSafeguardInput('10', '1 234,5', 'fr')).toEqual(
      validSafeguards(600, 1_234_500_000)
    );
    // A fraction long enough to round the integer up must not invalidate the
    // grouping the person typed.
    expect(parseBriefingSafeguardInput('10', '9.999,9999', 'de')).toEqual(
      validSafeguards(600, 9_999_999_900)
    );
  });
});

describe('briefingSyncDelayMs', () => {
  it('retries a failing dismissal journal with growing delays, then stops', () => {
    expect(briefingSyncDelayMs(0)).toBe(0);
    expect(briefingSyncDelayMs(1)).toBe(2000);
    expect(briefingSyncDelayMs(2)).toBe(8000);
    expect(briefingSyncDelayMs(3)).toBeNull();
    expect(briefingSyncDelayMs(10)).toBeNull();
  });
});
