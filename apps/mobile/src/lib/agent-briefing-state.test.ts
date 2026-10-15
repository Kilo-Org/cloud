import { type BriefingReport } from '@kilocode/app-shared/agent-briefing';
import { describe, expect, it } from 'vitest';

import {
  briefingEstimateUnavailableKey,
  canReadBriefingContext,
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
