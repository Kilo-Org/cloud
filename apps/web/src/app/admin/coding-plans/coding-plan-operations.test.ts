import {
  canSubmitExtensionDays,
  canSubmitReduceCount,
  getCancelSubscriptionDialogCopy,
  getCodingPlanInsights,
  getCodingPlanProviderDisplayName,
  getExtendSubscriptionDialogCopy,
  getInventoryReplacementCompleteToast,
  getInventoryReplacementDialogCopy,
  getPlanPerformanceRows,
  getReduceInventoryCompleteToast,
  getReduceInventoryDialogCopy,
  getReplacementCompleteToast,
  getReplacementDialogCopy,
  getRevocationCompleteToast,
  getRevocationDialogCopy,
  getSubscriptionSummaryItems,
  getSwapCredentialCompleteToast,
  getSwapCredentialDialogCopy,
} from '@/app/admin/coding-plans/coding-plan-operations';

const CATALOG = [
  { providerId: 'minimax', providerName: 'MiniMax' },
  { providerId: 'byteplus-coding', providerName: 'BytePlus' },
];

describe('getCodingPlanProviderDisplayName', () => {
  it('resolves provider names from the catalog', () => {
    expect(getCodingPlanProviderDisplayName(CATALOG, 'byteplus-coding')).toBe('BytePlus');
    expect(getCodingPlanProviderDisplayName(CATALOG, 'minimax')).toBe('MiniMax');
  });

  it('falls back to the provider ID for historical or unknown rows', () => {
    expect(getCodingPlanProviderDisplayName(CATALOG, 'legacy-provider')).toBe('legacy-provider');
    expect(getCodingPlanProviderDisplayName([], 'byteplus-coding')).toBe('byteplus-coding');
  });
});

describe('provider-aware revocation copy', () => {
  it('names the selected BytePlus work item without mentioning MiniMax', () => {
    const toast = getRevocationCompleteToast('BytePlus');
    const dialog = getRevocationDialogCopy('BytePlus');

    for (const copy of [toast, dialog.title, dialog.description]) {
      expect(copy).toContain('BytePlus');
      expect(copy).not.toContain('MiniMax');
    }
  });

  it('keeps MiniMax copy for MiniMax work items', () => {
    expect(getRevocationCompleteToast('MiniMax')).toBe('MiniMax credential removed from stock.');
    expect(getRevocationDialogCopy('MiniMax').title).toBe('Revoke MiniMax credential?');
  });

  it('stays provider-neutral when the provider is unknown', () => {
    expect(getRevocationCompleteToast(null)).toBe('Credential removed from stock.');
  });
});

describe('provider-aware replacement copy', () => {
  it('names the selected BytePlus work item without mentioning MiniMax', () => {
    const toast = getReplacementCompleteToast('BytePlus');
    const dialog = getReplacementDialogCopy('BytePlus');

    for (const copy of [toast, dialog.title, dialog.description, dialog.placeholder]) {
      expect(copy).toContain('BytePlus');
      expect(copy).not.toContain('MiniMax');
    }
  });

  it('keeps MiniMax copy for MiniMax work items', () => {
    expect(getReplacementCompleteToast('MiniMax')).toBe(
      'MiniMax credential replaced and returned to stock.'
    );
    expect(getReplacementDialogCopy('MiniMax').title).toBe('Replace MiniMax API key');
    expect(getReplacementDialogCopy('MiniMax').placeholder).toBe('Paste new MiniMax API key');
  });

  it('stays provider-neutral when the provider is unknown', () => {
    expect(getReplacementCompleteToast(null)).toBe('Credential replaced and returned to stock.');
  });
});

describe('inventory replacement copy', () => {
  it('describes encryption and assigned BYOK updates', () => {
    const dialog = getInventoryReplacementDialogCopy('11111111-1111-1111-1111-111111111111');
    expect(getInventoryReplacementCompleteToast()).toBe('Inventory credential replaced.');
    expect(dialog.title).toBe('Replace inventory API key');
    expect(dialog.description).toContain('11111111-1111-1111-1111-111111111111');
    expect(dialog.description).toContain('encrypts');
    expect(dialog.description).toContain('assigned BYOK');
  });
});

describe('canSubmitExtensionDays', () => {
  it('accepts whole days from 1 to 90 and rejects fractions', () => {
    expect(canSubmitExtensionDays('7')).toBe(true);
    expect(canSubmitExtensionDays('1.5')).toBe(false);
    expect(canSubmitExtensionDays('0')).toBe(false);
    expect(canSubmitExtensionDays('91')).toBe(false);
  });
});

describe('subscription action copy', () => {
  it('names the user in cancel and extend dialogs', () => {
    expect(getCancelSubscriptionDialogCopy('Ada').title).toBe("Cancel Ada's subscription?");
    expect(getCancelSubscriptionDialogCopy('Ada').description).toContain(
      'end of the current paid period'
    );
    expect(getExtendSubscriptionDialogCopy('Ada').title).toBe("Extend Ada's current period?");
    expect(getExtendSubscriptionDialogCopy('Ada').description).toContain(
      'without charging credits'
    );
  });

  it('names the user in the swap credential dialog and warns billing is unaffected', () => {
    expect(getSwapCredentialDialogCopy('Ada').title).toBe("Swap Ada's credential?");
    expect(getSwapCredentialDialogCopy('Ada').description).toContain('Billing');
    expect(getSwapCredentialCompleteToast()).toBe('Subscription moved to a new pooled credential.');
  });
});

describe('reduce inventory copy', () => {
  it('names the plan and explains the manual provider-side step', () => {
    const dialog = getReduceInventoryDialogCopy('minimax-token-plan-plus');
    expect(dialog.title).toBe('Queue minimax-token-plan-plus inventory for removal?');
    expect(dialog.description).toContain('Pending Key Removal queue');
    expect(dialog.description).toContain('remove the key from the provider');
  });

  it('bounds the requested count to a positive integer no greater than what is available', () => {
    expect(canSubmitReduceCount('3', 5)).toBe(true);
    expect(canSubmitReduceCount('5', 5)).toBe(true);
    expect(canSubmitReduceCount('6', 5)).toBe(false);
    expect(canSubmitReduceCount('0', 5)).toBe(false);
    expect(canSubmitReduceCount('1.5', 5)).toBe(false);
    expect(canSubmitReduceCount('abc', 5)).toBe(false);
  });

  it('reports the exact queued count and upstream plan IDs on success', () => {
    expect(getReduceInventoryCompleteToast(3, 3, ['plan-a', 'plan-b', 'plan-c'])).toBe(
      'Queued 3 credentials for removal in Pending Key Rotation. Deprovision using upstream plan IDs: plan-a, plan-b, plan-c'
    );
  });

  it('flags a shortfall when fewer credentials were queued than requested', () => {
    expect(getReduceInventoryCompleteToast(2, 5, ['plan-a', 'plan-b'])).toBe(
      'Queued 2 of 5 requested credentials for removal (the rest were claimed before queuing). Find them in Pending Key Rotation and deprovision using upstream plan IDs: plan-a, plan-b'
    );
  });

  it('explains that nothing was queued when every candidate was already claimed', () => {
    expect(getReduceInventoryCompleteToast(0, 2, [])).toBe(
      'No credentials were queued. They may have just been claimed by a subscription; refresh and try again.'
    );
  });
});

describe('aggregate insight helpers', () => {
  it('maps summary counts onto the existing subscription cards', () => {
    expect(
      getSubscriptionSummaryItems({
        total: 11,
        active: 6,
        pendingCancellation: 2,
        pastDue: 1,
      })
    ).toEqual([
      { label: 'Total subscriptions', count: 11 },
      { label: 'Active subscriptions', count: 6 },
      { label: 'Cancellation pending', count: 2 },
      { label: 'Past due subscriptions', count: 1 },
    ]);
  });

  it('preserves 7-day KPI copy from bounded totals', () => {
    const insights = getCodingPlanInsights(
      {
        liveSubscriptions: 4,
        pendingCancellation: 1,
        pastDue: 1,
        mrrKiloCredits: 80,
        revenueAtRiskKiloCredits: 40,
        pastDueMrrKiloCredits: 20,
        createdInRange: 3,
        createdInPriorRange: 2,
        canceledInRange: 1,
        liveAtRangeStart: 4,
        retainedFromRangeStart: 3,
        currentWaitersJoinedInRange: 2,
        currentWaitersJoinedInPriorRange: 1,
        currentWaitlistTotal: 5,
      },
      7
    );

    expect(insights).toEqual([
      { label: 'Active MRR', value: '$80', detail: '4 live subscriptions' },
      { label: '7-day growth', value: '100%', detail: '+2 net in last 7 days' },
      { label: '7-day retention', value: '75%', detail: '3/4 retained from 7 days ago' },
      { label: '7-day churn', value: '25%', detail: '1 canceled in last 7 days' },
      { label: 'Revenue at risk', value: '$40', detail: '1 canceling, 1 past due' },
      { label: 'New subscriptions', value: '3', detail: '2 created in prior 7 days' },
      {
        label: 'Cancellation pending',
        value: '25%',
        detail: '1/4 live subscriptions',
      },
      { label: 'Past due exposure', value: '$20', detail: '1 subscription in recovery' },
      {
        label: 'Current waiters joined (7-day)',
        value: '2',
        detail: '1 current waiters joined in prior 7 days · 5 currently waiting',
      },
    ]);
  });

  it('joins bounded plan insight rows with catalog and inventory counts', () => {
    expect(
      getPlanPerformanceRows({
        catalog: [
          {
            planId: 'minimax-token-plan-plus',
            planName: 'Token Plan Plus',
            providerName: 'MiniMax',
          },
          {
            planId: 'byteplus-coding-plan-team-lite',
            planName: 'Enterprise Coding Plan Lite',
            providerName: 'BytePlus',
          },
        ],
        inventoryCounts: [
          { planId: 'minimax-token-plan-plus', status: 'available', count: 4 },
          { planId: 'minimax-token-plan-plus', status: 'assigned', count: 2 },
        ],
        planInsights: [
          {
            planId: 'minimax-token-plan-plus',
            liveSubscriptions: 2,
            monthlyRecurringValueKiloCredits: 40,
            createdInRange: 1,
            canceledInRange: 0,
            currentWaitersJoinedInRange: 2,
            currentWaitlistTotal: 3,
          },
        ],
      })
    ).toEqual([
      {
        planId: 'minimax-token-plan-plus',
        planName: 'Token Plan Plus',
        providerName: 'MiniMax',
        activeSubscriptions: 2,
        monthlyRecurringValue: 40,
        newSubscriptionsInRange: 1,
        canceledSubscriptionsInRange: 0,
        availableCredentials: 4,
        waitlistIntents: 3,
        currentWaitersJoinedInRange: 2,
      },
      {
        planId: 'byteplus-coding-plan-team-lite',
        planName: 'Enterprise Coding Plan Lite',
        providerName: 'BytePlus',
        activeSubscriptions: 0,
        monthlyRecurringValue: 0,
        newSubscriptionsInRange: 0,
        canceledSubscriptionsInRange: 0,
        availableCredentials: 0,
        waitlistIntents: 0,
        currentWaitersJoinedInRange: 0,
      },
    ]);
  });
});
