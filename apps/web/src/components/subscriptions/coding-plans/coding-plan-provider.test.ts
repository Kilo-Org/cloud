import {
  getCodingPlanAccessNoticeVariant,
  getCodingPlanManagedKeyLabel,
  getCodingPlanPurchaseBlocker,
} from './coding-plan-provider';

const minimaxUserKey = { provider_id: 'minimax', management_source: 'user' };
const minimaxManagedKey = { provider_id: 'minimax', management_source: 'coding_plan' };
const byteplusUserKey = { provider_id: 'byteplus-coding', management_source: 'user' };
const byteplusManagedKey = { provider_id: 'byteplus-coding', management_source: 'coding_plan' };

function blockerFor(
  providerId: string,
  byokKeys: { provider_id: string; management_source: string }[],
  liveProviderIds: string[] = []
) {
  return getCodingPlanPurchaseBlocker({
    providerId,
    byokKeys,
    liveProviderIds: new Set(liveProviderIds),
  });
}

describe('getCodingPlanPurchaseBlocker', () => {
  it('does not block a provider with no keys and no live subscription', () => {
    const blocker = blockerFor('byteplus-coding', []);
    expect(blocker).toEqual({
      isBlocked: false,
      hasLiveSubscription: false,
      hasAnyKey: false,
      hasManagedKey: false,
      hasUserManagedKey: false,
    });
  });

  it('blocks the provider that owns a user-managed key, including a disabled key', () => {
    // Keys are not filtered by is_enabled: any key in the provider slot blocks.
    const blocker = blockerFor('byteplus-coding', [byteplusUserKey]);
    expect(blocker.isBlocked).toBe(true);
    expect(blocker.hasAnyKey).toBe(true);
    expect(blocker.hasUserManagedKey).toBe(true);
    expect(blocker.hasManagedKey).toBe(false);
  });

  it('blocks the provider that owns a managed key from a finishing subscription', () => {
    const blocker = blockerFor('byteplus-coding', [byteplusManagedKey]);
    expect(blocker.isBlocked).toBe(true);
    expect(blocker.hasManagedKey).toBe(true);
    expect(blocker.hasUserManagedKey).toBe(false);
  });

  it('blocks a provider with a live subscription even without keys', () => {
    const blocker = blockerFor('minimax', [], ['minimax']);
    expect(blocker.isBlocked).toBe(true);
    expect(blocker.hasLiveSubscription).toBe(true);
  });

  it('blocks only the provider that owns the key', () => {
    expect(blockerFor('byteplus-coding', [byteplusUserKey]).isBlocked).toBe(true);
    expect(blockerFor('minimax', [byteplusUserKey]).isBlocked).toBe(false);
    expect(blockerFor('minimax', [minimaxUserKey]).isBlocked).toBe(true);
    expect(blockerFor('byteplus-coding', [minimaxUserKey]).isBlocked).toBe(false);
  });

  it('lets MiniMax and BytePlus blocking coexist independently', () => {
    const keys = [minimaxManagedKey, byteplusUserKey];
    const minimax = blockerFor('minimax', keys, []);
    const byteplus = blockerFor('byteplus-coding', keys, []);
    expect(minimax.isBlocked).toBe(true);
    expect(minimax.hasManagedKey).toBe(true);
    expect(minimax.hasUserManagedKey).toBe(false);
    expect(byteplus.isBlocked).toBe(true);
    expect(byteplus.hasManagedKey).toBe(false);
    expect(byteplus.hasUserManagedKey).toBe(true);
  });

  it('ignores live subscriptions of other providers', () => {
    const blocker = blockerFor('byteplus-coding', [], ['minimax']);
    expect(blocker.isBlocked).toBe(false);
  });
});

describe('getCodingPlanAccessNoticeVariant', () => {
  it('prioritizes live subscription, then managed key, then user-managed key', () => {
    expect(
      getCodingPlanAccessNoticeVariant({
        hasLiveSubscription: true,
        hasManagedKey: true,
        hasUserManagedKey: true,
      })
    ).toBe('live_subscription');
    expect(
      getCodingPlanAccessNoticeVariant({
        hasLiveSubscription: false,
        hasManagedKey: true,
        hasUserManagedKey: true,
      })
    ).toBe('managed_key');
    expect(
      getCodingPlanAccessNoticeVariant({
        hasLiveSubscription: false,
        hasManagedKey: false,
        hasUserManagedKey: true,
      })
    ).toBe('user_managed_key');
    expect(
      getCodingPlanAccessNoticeVariant({
        hasLiveSubscription: false,
        hasManagedKey: false,
        hasUserManagedKey: false,
      })
    ).toBe('generic');
  });
});

describe('getCodingPlanManagedKeyLabel', () => {
  it('appends Coding Plan to a bare provider name', () => {
    expect(getCodingPlanManagedKeyLabel('MiniMax')).toBe(
      'Managed by MiniMax Coding Plan. This key is read-only.'
    );
  });

  it('keeps the exact BytePlus label without duplicating Coding Plan', () => {
    expect(getCodingPlanManagedKeyLabel('BytePlus Coding Plan')).toBe(
      'Managed by BytePlus Coding Plan. This key is read-only.'
    );
  });

  it('falls back safely for unknown provider display names', () => {
    expect(getCodingPlanManagedKeyLabel('unknown-provider')).toBe(
      'Managed by unknown-provider Coding Plan. This key is read-only.'
    );
  });
});
