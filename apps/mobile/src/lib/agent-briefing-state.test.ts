import { type BriefingReport } from '@kilocode/app-shared/agent-briefing';
import { describe, expect, it } from 'vitest';

import {
  briefingAccessDenied,
  briefingEstimateUnavailableKey,
  briefingReportMissing,
  briefingSyncDelayMs,
  canReadBriefingContext,
  parseBriefingSafeguards,
  readableBriefingOrganizationIds,
  visibleHomeBriefing,
} from './agent-briefing-state';

const now = Date.parse('2026-10-15T09:00:00Z');
const report: BriefingReport = {
  id: 'report-1',
  context: { id: 'personal', organizationId: null, name: 'Personal' },
  localDate: '2026-10-15',
  nightStartAt: '2026-10-14T22:00:00Z',
  cutoffAt: '2026-10-15T08:00:00Z',
  morningEndAt: '2026-10-15T12:00:00Z',
  publishedAt: '2026-10-15T08:00:00Z',
  updatedAt: '2026-10-15T08:00:00Z',
  expiresAt: '2026-10-15T12:00:00Z',
  revision: 1,
  revised: false,
  readAt: null,
  dismissedAt: null,
  scorecard: { sessions: 2, pullRequests: 1, blockers: 0, spendMicrodollars: 400_000 },
  coverage: { activity: 'partial', pullRequests: 'partial', blockers: 'partial', spend: 'partial' },
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
    canRetry: false,
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
    expect(briefingEstimateUnavailableKey('gateway_declined')).toBe(
      'agentBriefing.estimateUnavailable'
    );
    expect(briefingEstimateUnavailableKey(null)).toBe('agentBriefing.estimateUnavailable');
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

describe('parseBriefingSafeguards', () => {
  it('accepts the server range: whole seconds from 1 to 600 and a positive spend', () => {
    expect(parseBriefingSafeguards(10, 2)).toEqual({
      maxDurationSeconds: 600,
      maxSpendMicrodollars: 2_000_000,
    });
    expect(parseBriefingSafeguards(1 / 60, 0.5)).toEqual({
      maxDurationSeconds: 1,
      maxSpendMicrodollars: 500_000,
    });
  });

  it('rejects a duration the server would refuse', () => {
    expect(parseBriefingSafeguards(10.1, 2)).toBeNull();
    expect(parseBriefingSafeguards(60, 2)).toBeNull();
    expect(parseBriefingSafeguards(0, 2)).toBeNull();
    expect(parseBriefingSafeguards(-1, 2)).toBeNull();
  });

  it('rejects a non-finite or non-positive spend', () => {
    expect(parseBriefingSafeguards(5, 0)).toBeNull();
    expect(parseBriefingSafeguards(5, Number.NaN)).toBeNull();
    expect(parseBriefingSafeguards(Number.POSITIVE_INFINITY, 2)).toBeNull();
    expect(parseBriefingSafeguards(5, Number.MAX_SAFE_INTEGER)).toBeNull();
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
