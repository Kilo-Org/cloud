import { describe, expect, it } from 'vitest';

import {
  getOrgKiloPassUsageState,
  type OrgKiloPassUsageAllocation,
  type OrgKiloPassUsageOutput,
} from '@/components/organization/org-kilo-pass-usage-state';

function allocation(overrides?: Partial<OrgKiloPassUsageAllocation>): OrgKiloPassUsageAllocation {
  return {
    organizationId: 'org-1',
    organizationName: 'Acme',
    passCount: 2,
    kind: 'parent',
    hasProratedCredits: false,
    baseCreditsMicrodollars: 40_000_000,
    qualifyingSpendMicrodollars: 10_000_000,
    unlockTargetMicrodollars: 40_000_000,
    bonusCreditsMicrodollars: 5_000_000,
    bonusState: 'locked',
    ...overrides,
  };
}

function usage(overrides?: Partial<OrgKiloPassUsageOutput>): OrgKiloPassUsageOutput {
  return {
    tier: 'tier_49',
    terms: {
      tier: 'tier_49',
      tierName: 'Kilo Pass 49',
      pricePerPassUsd: 49,
      baseCreditsPerPassUsd: 20,
      bonusCreditsPerPassUsd: 5,
      unlockSpendPerPassUsd: 20,
      bonusMode: 'after_base',
    },
    currentWindow: {
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-12-01T00:00:00.000Z',
    },
    currentAllocations: [allocation()],
    ...overrides,
  };
}

/** Both gates open, with a settled successful read. */
const OPEN = {
  agreementOpen: true,
  hasBillingRole: true,
  isPending: false,
  isError: false,
  error: null,
} as const;

describe('getOrgKiloPassUsageState gates', () => {
  it('hides the section without a billing role', () => {
    expect(getOrgKiloPassUsageState({ ...OPEN, hasBillingRole: false, data: usage() })).toEqual({
      kind: 'hidden',
    });
  });

  it('hides the section with no live agreement, even once data arrives', () => {
    expect(getOrgKiloPassUsageState({ ...OPEN, agreementOpen: false, data: usage() })).toEqual({
      kind: 'hidden',
    });
  });
});

describe('getOrgKiloPassUsageState phases', () => {
  it('is loading while the first read is pending', () => {
    expect(getOrgKiloPassUsageState({ ...OPEN, isPending: true, data: undefined })).toEqual({
      kind: 'loading',
    });
  });

  it('is retryable on a failure with no terminal code', () => {
    expect(
      getOrgKiloPassUsageState({
        ...OPEN,
        isError: true,
        error: new Error('network down'),
        data: undefined,
      })
    ).toEqual({ kind: 'retryable' });
    expect(
      getOrgKiloPassUsageState({
        ...OPEN,
        isError: true,
        error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
        data: undefined,
      })
    ).toEqual({ kind: 'retryable' });
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'])('is unavailable on the terminal %s', code => {
    expect(
      getOrgKiloPassUsageState({
        ...OPEN,
        isError: true,
        error: { data: { code } },
        data: undefined,
      })
    ).toEqual({ kind: 'unavailable' });
  });

  it('is empty when the read answered null, which is an agreement with no window yet', () => {
    expect(getOrgKiloPassUsageState({ ...OPEN, data: null })).toEqual({ kind: 'empty' });
    expect(getOrgKiloPassUsageState({ ...OPEN, data: undefined })).toEqual({ kind: 'empty' });
  });

  it('is empty on an allocation list with no rows', () => {
    expect(getOrgKiloPassUsageState({ ...OPEN, data: usage({ currentAllocations: [] }) })).toEqual({
      kind: 'empty',
    });
  });

  it('is ready with the rows and the full monthly Credits per pass', () => {
    const data = usage();
    expect(getOrgKiloPassUsageState({ ...OPEN, data })).toEqual({
      kind: 'ready',
      allocations: data.currentAllocations,
      fullMonthlyCreditsPerPassUsd: 20,
    });
  });
});
