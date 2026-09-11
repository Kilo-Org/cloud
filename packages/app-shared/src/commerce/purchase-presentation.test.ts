import { describe, expect, it } from 'vitest';

import {
  isNativeIapMutationAllowed,
  mapKiloPassStatusToClass,
  resolvePurchasePresentation,
} from './purchase-presentation';

describe('resolvePurchasePresentation', () => {
  it('marks iOS credits unavailable with no CTA', () => {
    const result = resolvePurchasePresentation({
      platform: 'ios',
      storefront: 'app_store',
      product: 'credits',
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('credits_not_sold_on_ios');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('marks Android credits as web_management with a /credits CTA', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'credits',
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('web_management');
    expect(result.cta).toEqual({ action: 'open_web', webPath: '/credits' });
  });

  it('marks iOS App Store Kilo Pass as native_iap', () => {
    const result = resolvePurchasePresentation({
      platform: 'ios',
      storefront: 'app_store',
      product: 'kilo_pass',
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('native_iap');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('marks Android Kilo Pass without Stripe as unavailable', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'kilo_pass',
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('kilo_pass_not_available_on_android');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('marks Android Kilo Pass with Stripe as web_management with a /subscriptions/kilo-pass CTA', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'kilo_pass',
      hasStripeManagedPass: true,
    });

    expect(result.kind).toBe('web_management');
    expect(result.cta).toEqual({
      action: 'open_web',
      webPath: '/subscriptions/kilo-pass',
    });
  });

  it('marks Android Play Kilo Pass with native support and no Stripe as native_iap with NO_CTA', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'kilo_pass',
      supportsNativePlayKiloPass: true,
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('native_iap');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('marks Android Play Kilo Pass with native support and a Stripe sub as native_iap', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'kilo_pass',
      supportsNativePlayKiloPass: true,
      hasStripeManagedPass: true,
    });

    expect(result.kind).toBe('native_iap');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('keeps Android Play Kilo Pass without native support and no Stripe unavailable', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'kilo_pass',
      supportsNativePlayKiloPass: false,
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('kilo_pass_not_available_on_android');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('keeps Android Play Kilo Pass without native support and Stripe as web_management', () => {
    const result = resolvePurchasePresentation({
      platform: 'android',
      storefront: 'play',
      product: 'kilo_pass',
      supportsNativePlayKiloPass: false,
      hasStripeManagedPass: true,
    });

    expect(result.kind).toBe('web_management');
    expect(result.cta).toEqual({
      action: 'open_web',
      webPath: '/subscriptions/kilo-pass',
    });
  });

  it('marks a missing platform as unavailable with no CTA', () => {
    const result = resolvePurchasePresentation({
      platform: null,
      storefront: 'web',
      product: 'kilo_pass',
      hasStripeManagedPass: true,
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('unsupported_combination');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('marks iOS Kilo Pass on a non-App Store storefront as unavailable', () => {
    const result = resolvePurchasePresentation({
      platform: 'ios',
      storefront: 'web',
      product: 'kilo_pass',
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('unavailable');
    expect(result.cta).toEqual({ action: 'none', webPath: null });
  });

  it('echoes the program without changing the kind', () => {
    const result = resolvePurchasePresentation({
      platform: 'ios',
      storefront: 'app_store',
      product: 'kilo_pass',
      program: 'promo-123',
      hasStripeManagedPass: false,
    });

    expect(result.kind).toBe('native_iap');
    expect(result.program).toBe('promo-123');
  });

  it('defaults a missing program to null', () => {
    const result = resolvePurchasePresentation({
      platform: 'ios',
      storefront: 'app_store',
      product: 'kilo_pass',
      hasStripeManagedPass: false,
    });

    expect(result.program).toBeNull();
  });
});

describe('mapKiloPassStatusToClass', () => {
  it('maps active to healthy', () => {
    expect(mapKiloPassStatusToClass('active', { hasSubscription: true })).toBe('healthy');
  });

  it('maps incomplete to pending', () => {
    expect(mapKiloPassStatusToClass('incomplete', { hasSubscription: true })).toBe('pending');
  });

  it('maps trialing to pending', () => {
    expect(mapKiloPassStatusToClass('trialing', { hasSubscription: true })).toBe('pending');
  });

  it('maps past_due to retryable', () => {
    expect(mapKiloPassStatusToClass('past_due', { hasSubscription: true })).toBe('retryable');
  });

  it('maps canceled to terminal', () => {
    expect(mapKiloPassStatusToClass('canceled', { hasSubscription: true })).toBe('terminal');
  });

  it('maps incomplete_expired to terminal', () => {
    expect(mapKiloPassStatusToClass('incomplete_expired', { hasSubscription: true })).toBe(
      'terminal'
    );
  });

  it('maps unpaid to terminal', () => {
    expect(mapKiloPassStatusToClass('unpaid', { hasSubscription: true })).toBe('terminal');
  });

  it('maps paused to inactive', () => {
    expect(mapKiloPassStatusToClass('paused', { hasSubscription: true })).toBe('inactive');
  });

  it('maps no subscription to inactive regardless of status', () => {
    expect(mapKiloPassStatusToClass('active', { hasSubscription: false })).toBe('inactive');
  });
});

describe('isNativeIapMutationAllowed', () => {
  it('is true for iOS App Store and Android Play Kilo Pass', () => {
    expect(
      isNativeIapMutationAllowed({ platform: 'ios', storefront: 'app_store', product: 'kilo_pass' })
    ).toBe(true);
    expect(
      isNativeIapMutationAllowed({ platform: 'android', storefront: 'play', product: 'kilo_pass' })
    ).toBe(true);
  });

  it('is false for iOS credits', () => {
    expect(
      isNativeIapMutationAllowed({ platform: 'ios', storefront: 'app_store', product: 'credits' })
    ).toBe(false);
  });

  it('is false for Android credits', () => {
    expect(
      isNativeIapMutationAllowed({ platform: 'android', storefront: 'play', product: 'credits' })
    ).toBe(false);
  });

  it('is false for Android Kilo Pass on a non-Play storefront', () => {
    expect(
      isNativeIapMutationAllowed({ platform: 'android', storefront: 'web', product: 'kilo_pass' })
    ).toBe(false);
  });

  it('is false for a non-App Store storefront', () => {
    expect(
      isNativeIapMutationAllowed({ platform: 'ios', storefront: 'web', product: 'kilo_pass' })
    ).toBe(false);
  });

  it('is false for a missing platform', () => {
    expect(
      isNativeIapMutationAllowed({ platform: null, storefront: 'app_store', product: 'kilo_pass' })
    ).toBe(false);
  });
});
