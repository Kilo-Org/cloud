import {
  toActivationView,
  toCondition,
  toCurrentAllocation,
  toCurrentAllocations,
  toDetailPresentation,
  toOrgKiloPassTerms,
  toSetupAllocations,
  toSetupTerms,
} from './mappers';
import type { OrgKiloPassTerms } from './types';

const starterTerms: OrgKiloPassTerms = {
  tier: 'tier_19',
  tierName: 'Starter',
  pricePerPassUsd: 19,
  baseCreditsPerPassUsd: 19,
  bonusCreditsPerPassUsd: 4,
  unlockSpendPerPassUsd: 19,
  bonusMode: 'after_base',
};

describe('organization Kilo Pass mappers', () => {
  test('maps processing conditions onto customer-facing conditions', () => {
    expect(toCondition('overallocated')?.kind).toBe('overallocated');
    expect(toCondition('blocked')?.kind).toBe('blocked');
    expect(toCondition('manual')?.kind).toBe('manual');
    expect(toCondition('failed')?.kind).toBe('failed');
    expect(toCondition('suspended_for_review')?.kind).toBe('payment_review');
    expect(toCondition('ready')).toBeUndefined();
  });

  test('maps current allocation microdollars onto USD view amounts', () => {
    const allocation = toCurrentAllocation({
      organizationId: '7b64f360-7a87-4483-a614-ccfdf061e184',
      organizationName: 'Acme Co',
      passCount: 25,
      kind: 'parent',
      hasProratedCredits: true,
      baseCreditsMicrodollars: 442_670_000,
      qualifyingSpendMicrodollars: 120_500_000,
      unlockTargetMicrodollars: 442_670_000,
      bonusCreditsMicrodollars: 93_190_000,
      bonusState: 'locked',
    });

    expect(allocation).toEqual({
      organizationId: '7b64f360-7a87-4483-a614-ccfdf061e184',
      organizationName: 'Acme Co',
      passCount: 25,
      kind: 'parent',
      hasProratedCredits: true,
      baseCreditsUsd: 442.67,
      qualifyingSpendUsd: 120.5,
      unlockTargetUsd: 442.67,
      bonusCreditsUsd: 93.19,
      bonusState: 'locked',
    });
  });

  test('maps every allocation in the list', () => {
    const allocations = toCurrentAllocations([
      {
        organizationId: '7b64f360-7a87-4483-a614-ccfdf061e184',
        organizationName: 'Acme Co',
        passCount: 25,
        kind: 'parent',
        hasProratedCredits: false,
        baseCreditsMicrodollars: 475_000_000,
        qualifyingSpendMicrodollars: 0,
        unlockTargetMicrodollars: 475_000_000,
        bonusCreditsMicrodollars: 100_000_000,
        bonusState: 'unlocked',
      },
      {
        organizationId: '0b575b69-03f6-477c-8b20-bb2ad726c320',
        organizationName: 'Engineering',
        passCount: 0,
        kind: 'child',
        hasProratedCredits: false,
        baseCreditsMicrodollars: 0,
        qualifyingSpendMicrodollars: 0,
        unlockTargetMicrodollars: 0,
        bonusCreditsMicrodollars: 0,
        bonusState: 'locked',
      },
    ]);

    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toMatchObject({
      organizationName: 'Acme Co',
      baseCreditsUsd: 475,
      bonusCreditsUsd: 100,
      bonusState: 'unlocked',
    });
    expect(allocations[1]).toMatchObject({
      organizationName: 'Engineering',
      baseCreditsUsd: 0,
      kind: 'child',
    });
  });

  test('uses versioned API terms', () => {
    const apiTerms = {
      ...starterTerms,
      tier: 'tier_49' as const,
      tierName: 'Pro (negotiated)',
      pricePerPassUsd: 39,
    };

    expect(toOrgKiloPassTerms({ tier: 'tier_49', terms: apiTerms })).toBe(apiTerms);
  });

  test('uses setup terms from the API', () => {
    const apiTerms = [starterTerms];

    expect(toSetupTerms({ paidSeatCount: 6, terms: apiTerms })).toBe(apiTerms);
  });

  test('resolves detail presentation from versioned fields', () => {
    const apiTerms = { ...starterTerms, tierName: 'Starter (legacy)' };

    expect(toDetailPresentation({ tier: 'tier_19', terms: apiTerms, cadence: 'yearly' })).toEqual({
      terms: apiTerms,
      cadence: 'annual',
    });
  });

  test('initializes a parent remainder and direct-child allocations', () => {
    expect(
      toSetupAllocations('parent-id', 'Parent', [
        { id: 'child-a', name: 'Child A' },
        { id: 'child-b', name: 'Child B' },
      ])
    ).toEqual([
      { organizationId: 'parent-id', organizationName: 'Parent', kind: 'parent', passCount: 0 },
      { organizationId: 'child-a', organizationName: 'Child A', kind: 'child', passCount: 0 },
      { organizationId: 'child-b', organizationName: 'Child B', kind: 'child', passCount: 0 },
    ]);
  });
});

describe('toActivationView', () => {
  const base = {
    state: 'pending_payment' as const,
    commercialState: 'pending_payment' as const,
    processingCondition: 'ready' as const,
    message: null,
  };

  test('treats active and cancel_at_period_end as terminal success states', () => {
    for (const commercialState of ['active', 'cancel_at_period_end'] as const) {
      const view = toActivationView({ ...base, state: commercialState, commercialState });
      expect(view.state).toBe('succeeded');
      expect(view.shouldPoll).toBe(false);
      expect(view.actionTarget).toBe('kilo_pass_detail');
    }
  });

  test('treats ended as a terminal state without polling', () => {
    const view = toActivationView({ ...base, state: 'ended', commercialState: 'ended' });
    expect(view.state).toBe('ended');
    expect(view.shouldPoll).toBe(false);
    expect(view.actionTarget).toBe('subscriptions');
  });

  test('stops polling when payment requires action and points at billing', () => {
    const view = toActivationView({ ...base, processingCondition: 'suspended_for_review' });
    expect(view.state).toBe('requires_action');
    expect(view.shouldPoll).toBe(false);
    expect(view.actionTarget).toBe('billing_portal');
  });

  test('stops polling when activation is blocked and points at pass assignments', () => {
    const view = toActivationView({ ...base, processingCondition: 'blocked' });
    expect(view.state).toBe('blocked');
    expect(view.shouldPoll).toBe(false);
    expect(view.actionTarget).toBe('kilo_pass_detail');
  });

  test('keeps polling through a failed run because Kilo retries automatically', () => {
    const view = toActivationView({ ...base, processingCondition: 'failed' });
    expect(view.state).toBe('failed');
    expect(view.shouldPoll).toBe(true);
    expect(view.actionLabel).toBeUndefined();
  });

  test('keeps polling while payment is pending or activation is in progress', () => {
    expect(toActivationView(base).state).toBe('awaiting_payment');
    expect(toActivationView(base).shouldPoll).toBe(true);

    const activating = toActivationView({
      state: 'activating',
      commercialState: null,
      processingCondition: null,
      message: null,
    });
    expect(activating.state).toBe('activating');
    expect(activating.shouldPoll).toBe(true);
  });

  test('treats a missing or unavailable agreement as a non-polling dead end', () => {
    for (const result of [
      null,
      { state: 'unavailable', commercialState: null, processingCondition: null, message: null },
    ] as const) {
      const view = toActivationView(result);
      expect(view.state).toBe('blocked');
      expect(view.shouldPoll).toBe(false);
      expect(view.actionTarget).toBe('subscriptions');
    }
  });

  test('prefers the backend message when one is provided', () => {
    const view = toActivationView({ ...base, message: 'Custom backend message' });
    expect(view.description).toBe('Custom backend message');
  });
});
